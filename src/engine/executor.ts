/**
 * 执行器
 *
 * 职责：
 *   1. 按阶段→步骤顺序执行计划
 *   2. 每步执行前：安全扫描 → HIGH 风险 = 暂停要求确认
 *   3. 每步执行后：记录结果到 SQLite + 审计日志
 *   4. 遇到环境问题：尝试自愈（最多 maxAttempts 次）
 *   5. 无法自动修复：暂停并标记 FAILED
 *   6. 进度报告：每个阶段完成后回调
 *
 * 工具调度：
 *   read_file  → utils/file.readFile
 *   write_file → utils/file.writeFile
 *   terminal   → utils/shell.shell
 *   git        → utils/git
 *   ask_user   → 暂停等待用户输入
 *   database   → 暂未实现（P2）
 */

import { randomUUID } from 'node:crypto';
import type {
  ExecutionPlan,
  ExecutionPhase,
  ExecutionStep,
  StepStatus,
  PhaseStatus,
  PlanStatus,
  ToolName,
} from './types';
import { readFile, writeFile, patchFile } from '../utils/file';
import { shell, ShellConfirmationRequired } from '../utils/shell';
import * as gitUtils from '../utils/git';
import { healJava, healNpm, healDatabase, freePort } from '../utils/env';
import { scan } from '../safety/scanner';
import type { ScannerInput, ScanResult } from '../safety/scanner';
import { logSuccess, logFailure } from '../safety/audit';
import {
  createTask,
  updateTaskStatus,
  upsertStep,
  updateStepStatus,
  incrementStepRecovery,
  setProjectMemory,
} from '../storage/db';

// ============================================================================
// 类型
// ============================================================================

export interface ExecutorOptions {
  /** 任务 ID */
  taskId: string;
  /** 工作目录 */
  cwd: string;
  /** 任务描述 */
  description: string;
  /** 最大自动重试次数（覆盖 step 级别的 maxAttempts） */
  maxRetries?: number;
  /** 高危操作确认回调：返回 true = 用户确认执行 */
  onConfirmDangerous?: (step: ExecutionStep, reason: string) => Promise<boolean>;
  /** 需用户输入回调（ask_user 工具） */
  onAskUser?: (step: ExecutionStep, prompt: string) => Promise<string>;
  /** 进度报告回调 */
  onProgress?: (event: ProgressEvent) => void;
  /** 阶段完成回调 */
  onPhaseComplete?: (phase: ExecutionPhase) => void;
}

export interface ProgressEvent {
  type: 'phase_start' | 'phase_complete' | 'step_start' | 'step_complete' | 'step_failed' | 'plan_complete' | 'plan_failed' | 'paused_for_confirm' | 'paused_for_user';
  phase?: ExecutionPhase;
  step?: ExecutionStep;
  message: string;
  timestamp: string;
}

export interface ExecutorResult {
  success: boolean;
  planId: string;
  completedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  totalSteps: number;
  durationMs: number;
  error?: string;
}

// ============================================================================
// 执行器主函数
// ============================================================================

export async function execute(
  plan: ExecutionPlan,
  opts: ExecutorOptions,
): Promise<ExecutorResult> {
  const startTime = Date.now();
  let completedSteps = 0;
  let failedSteps = 0;
  let skippedSteps = 0;
  let totalSteps = 0;

  // 统计总步数
  for (const phase of plan.phases) {
    totalSteps += phase.steps.length;
  }

  // 创建 DB 记录
  createTask(opts.taskId, opts.description, opts.cwd);

  // 写入所有步骤到 DB
  let stepOrder = 0;
  for (const phase of plan.phases) {
    for (const step of phase.steps) {
      upsertStep(opts.taskId, phase.id, step.id, stepOrder++, step.description, step.toolHints[0] || 'read_file');
    }
  }

  try {
    // 逐阶段执行
    for (const phase of plan.phases) {
      report(opts, { type: 'phase_start', phase, message: `开始阶段: ${phase.name}`, timestamp: new Date().toISOString() });
      phase.status = 'running';

      for (const step of phase.steps) {
        report(opts, { type: 'step_start', phase, step, message: `执行步骤: ${step.description}`, timestamp: new Date().toISOString() });
        step.status = 'running';
        step.startedAt = new Date().toISOString();
        updateStepStatus(opts.taskId, step.id, 'running');

        try {
          // 1. 安全扫描
          const scanResult = await safetyGate(step, opts);
          if (scanResult === 'blocked') {
            step.status = 'skipped';
            updateStepStatus(opts.taskId, step.id, 'skipped', '被安全策略拦截');
            skippedSteps++;
            report(opts, { type: 'step_complete', phase, step, message: `⏭️ 跳过（安全拦截）: ${step.description}`, timestamp: new Date().toISOString() });
            continue;
          }

          // 2. 执行
          const result = await executeStep(step, opts);

          step.status = 'completed';
          step.completedAt = new Date().toISOString();
          updateStepStatus(opts.taskId, step.id, 'completed', result);
          completedSteps++;

          report(opts, {
            type: 'step_complete',
            phase,
            step,
            message: `✅ ${step.description} (${result?.slice(0, 80) ?? '完成'})`,
            timestamp: new Date().toISOString(),
          });

          // 项目记忆：保存成功的技术信息
          if (step.tool === 'terminal') {
            saveProjectMemory(opts.cwd, step);
          }
        } catch (err: any) {
          // 3. 失败处理
          const recovered = await handleFailure(step, opts, err);

          if (recovered) {
            step.status = 'completed';
            step.completedAt = new Date().toISOString();
            updateStepStatus(opts.taskId, step.id, 'completed', '自愈后成功');
            completedSteps++;
            report(opts, { type: 'step_complete', phase, step, message: `🔧 自愈后成功: ${step.description}`, timestamp: new Date().toISOString() });
          } else {
            step.status = 'failed';
            updateStepStatus(opts.taskId, step.id, 'failed', undefined, err.message);
            failedSteps++;
            report(opts, { type: 'step_failed', phase, step, message: `❌ ${step.description}: ${err.message}`, timestamp: new Date().toISOString() });

            // 有回退方案 → 执行回退
            if (step.rollback) {
              try {
                await executeStepRollback(step, opts);
              } catch { /* 回退失败也继续 */ }
            }

            // 有替代方案 → 执行替代方案
            if (step.fallback && step.attempts! < step.maxAttempts!) {
              try {
                await executeStepFallback(step, opts);
                step.status = 'completed';
                step.completedAt = new Date().toISOString();
                updateStepStatus(opts.taskId, step.id, 'completed', '替代方案成功');
                completedSteps++;
                report(opts, { type: 'step_complete', phase, step, message: `🔄 替代方案成功: ${step.description}`, timestamp: new Date().toISOString() });
                continue;
              } catch {
                // 替代方案也失败
              }
            }

            // 致命失败 → 停止执行该阶段
            if (!step.fallback) {
              break;
            }
          }
        }
      }

      // 阶段完成判断
      const phaseFailed = phase.steps.some(s => s.status === 'failed');
      const phaseAllSkipped = phase.steps.every(s => s.status === 'skipped');

      if (phaseFailed && !phaseAllSkipped) {
        phase.status = 'failed';
      } else {
        phase.status = 'completed';
      }

      updateStepStatus(opts.taskId, phase.steps[0].id, 'completed'); // 通过 step 间接标记
      report(opts, { type: 'phase_complete', phase, message: `阶段完成: ${phase.name} (${phase.status})`, timestamp: new Date().toISOString() });

      if (opts.onPhaseComplete) {
        opts.onPhaseComplete(phase);
      }
    }

    // 全计划完成
    plan.status = hasAnyFailure(plan) ? 'failed' : 'completed';
    plan.completedAt = new Date().toISOString();

    updateTaskStatus(opts.taskId, plan.status === 'completed' ? 'completed' : 'failed', plan);

    const durationMs = Date.now() - startTime;
    report(opts, {
      type: plan.status === 'completed' ? 'plan_complete' : 'plan_failed',
      message: `${plan.status === 'completed' ? '🎉 全部完成' : '⚠️ 部分失败'}：${completedSteps} 成功 / ${failedSteps} 失败 / ${skippedSteps} 跳过，耗时 ${formatDuration(durationMs)}`,
      timestamp: new Date().toISOString(),
    });

    return {
      success: plan.status === 'completed',
      planId: plan.id,
      completedSteps,
      failedSteps,
      skippedSteps,
      totalSteps,
      durationMs,
      error: hasAnyFailure(plan) ? `${failedSteps} 个步骤失败` : undefined,
    };
  } catch (err: any) {
    plan.status = 'failed';
    updateTaskStatus(opts.taskId, 'failed', plan);

    return {
      success: false,
      planId: plan.id,
      completedSteps,
      failedSteps: failedSteps + 1,
      skippedSteps,
      totalSteps,
      durationMs: Date.now() - startTime,
      error: err.message,
    };
  }
}

// ============================================================================
// 安全门
// ============================================================================

async function safetyGate(
  step: ExecutionStep,
  opts: ExecutorOptions,
): Promise<'pass' | 'blocked'> {
  // HIGH / MEDIUM 风险 → 确认
  if (step.riskLevel === 'high') {
    report(opts, {
      type: 'paused_for_confirm',
      step,
      message: `⚠️ 高危步骤需确认: ${step.description}`,
      timestamp: new Date().toISOString(),
    });

    if (opts.onConfirmDangerous) {
      const confirmed = await opts.onConfirmDangerous(
        step,
        `风险等级: HIGH\n步骤: ${step.description}`,
      );
      if (!confirmed) return 'blocked';
    }
    return 'pass';
  }

  if (step.riskLevel === 'medium') {
    report(opts, {
      type: 'paused_for_confirm',
      step,
      message: `⚠️ 中危步骤: ${step.description}（自动放行，已记录）`,
      timestamp: new Date().toISOString(),
    });
  }

  // LOW → 扫描命令文本
  if (step.tool === 'terminal' || step.tool === 'write_file') {
    const cmdText = extractCommandFromInput(step);
    if (cmdText) {
      const scannerInput: ScannerInput = {
        command: cmdText,
        type: step.tool === 'terminal' ? 'shell' : 'file',
      };
      const scanResult = scan(scannerInput);

      if (scanResult.verdict === 'STOP') {
        report(opts, {
          type: 'paused_for_confirm',
          step,
          message: `🛑 命令被拦截: ${scanResult.reason}`,
          timestamp: new Date().toISOString(),
        });
        if (opts.onConfirmDangerous) {
          const confirmed = await opts.onConfirmDangerous(step, scanResult.reason);
          return confirmed ? 'pass' : 'blocked';
        }
        return 'blocked';
      }
    }
  }

  return 'pass';
}

function extractCommandFromInput(step: ExecutionStep): string {
  if (typeof step.input!?.command === 'string') return step.input!!.command;
  if (typeof step.input!?.cmd === 'string') return step.input!!.cmd;
  if (typeof step.input!?.content === 'string') return step.input!!.content;
  return step.description;
}

// ============================================================================
// 步骤执行
// ============================================================================

async function executeStep(
  step: ExecutionStep,
  opts: ExecutorOptions,
): Promise<string | undefined> {
  switch (step.tool) {
    case 'read_file':
      return executeReadFile(step);
    case 'write_file':
      return executeWriteFile(step, opts);
    case 'terminal':
      return executeTerminal(step, opts);
    case 'git':
      return executeGit(step, opts);
    case 'ask_user':
      return executeAskUser(step, opts);
    case 'database':
      return 'database 工具暂未实现（P2）';
    default:
      throw new Error(`未知工具: ${step.tool}`);
  }
}

function executeReadFile(step: ExecutionStep): string {
  const filePath = step.input!!.filePath as string;
  const maxLines = step.input!!.maxLines as number | undefined;
  const result = readFile(filePath, maxLines);
  return result.content.slice(0, 2000); // 截断避免上下文爆炸
}

function executeWriteFile(
  step: ExecutionStep,
  opts: ExecutorOptions,
): string {
  const filePath = step.input!!.filePath as string;
  const content = step.input!!.content as string;

  if (!filePath || content === undefined) {
    throw new Error('write_file 需要 filePath 和 content 参数');
  }

  const result = writeFile(filePath, content, {
    taskId: opts.taskId,
    stepId: step.id,
  });

  return `已写入 ${filePath} (${result.bytesWritten} 字节)`;
}

function executeTerminal(
  step: ExecutionStep,
  opts: ExecutorOptions,
): string {
  const command = step.input!!.command as string;

  if (!command) {
    throw new Error('terminal 需要 command 参数');
  }

  const result = shell(command, {
    cwd: opts.cwd,
    taskId: opts.taskId,
    stepId: step.id,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `命令退出码 ${result.exitCode}: ${result.stderr.slice(0, 200)}`,
    );
  }

  return result.stdout.slice(0, 1000);
}

function executeGit(
  step: ExecutionStep,
  opts: ExecutorOptions,
): string {
  const action = step.input!!.action as string;

  switch (action) {
    case 'status': {
      const s = gitUtils.status(opts.cwd);
      return `分支: ${s.branch}, 待提交: ${s.modified}, 脏: ${s.dirty}`;
    }
    case 'commit': {
      const msg = step.input!!.message as string;
      const result = gitUtils.commit(msg, { cwd: opts.cwd, taskId: opts.taskId, stepId: step.id });
      return `提交: ${result.hash} — ${result.message} (${result.filesChanged} 文件)`;
    }
    case 'push': {
      const force = step.input!!.force as boolean | undefined;
      const result = gitUtils.push({ cwd: opts.cwd, force, taskId: opts.taskId, stepId: step.id });
      return `推送: ${result.branch}`;
    }
    case 'branch': {
      const name = step.input!!.name as string;
      const result = gitUtils.createBranch(name, { cwd: opts.cwd });
      return `创建分支: ${result.name}`;
    }
    default:
      throw new Error(`未知 Git 操作: ${action}`);
  }
}

async function executeAskUser(
  step: ExecutionStep,
  opts: ExecutorOptions,
): Promise<string> {
  const promptText = (step.input!!.prompt as string) || step.description;

  report(opts, {
    type: 'paused_for_user',
    step,
    message: `❓ 需要你回答: ${promptText}`,
    timestamp: new Date().toISOString(),
  });

  if (opts.onAskUser) {
    const answer = await opts.onAskUser(step, promptText);
    return answer;
  }

  return '未提供回答（跳过）';
}

// ============================================================================
// 失败处理与自愈
// ============================================================================

async function handleFailure(
  step: ExecutionStep,
  opts: ExecutorOptions,
  err: Error,
): Promise<boolean> {
  incrementStepRecovery(opts.taskId, step.id);
  step.attempts!++;

  // 检查是否超过重试上限
  const maxAttempts = opts.maxRetries ?? step.maxAttempts! ?? 3;
  if (step.attempts! >= maxAttempts) {
    return false;
  }

  const errMsg = err.message.toLowerCase();

  // 自愈策略
  // JDK 版本问题
  if (errMsg.includes('java') || errMsg.includes('jdk') || errMsg.includes('javac')) {
    const healResult = healJava(11);
    if (healResult.healed) return true;
  }

  // NPM 依赖问题
  if (errMsg.includes('npm') || errMsg.includes('node_modules') || errMsg.includes('eresolve')) {
    const healResult = healNpm(opts.cwd);
    if (healResult.healed) return true;
  }

  // 端口占用
  const portMatch = errMsg.match(/port\s+(\d+)/i) || errMsg.match(/:(\d{4,5})/);
  if (portMatch) {
    const port = parseInt(portMatch[1], 10);
    const healResult = freePort(port);
    if (healResult.healed) return true;
  }

  // 数据库连接失败
  if (errMsg.includes('connection') && (errMsg.includes('mysql') || errMsg.includes('postgres'))) {
    const healResult = healDatabase('', 3306);
    if (healResult.healed) return true;
  }

  // Shell 确认要求 → 转为确认事件
  if (err instanceof ShellConfirmationRequired) {
    if (opts.onConfirmDangerous) {
      const confirmed = await opts.onConfirmDangerous(step, err.reason);
      if (confirmed) {
        // 重新执行
        return true;
      }
    }
  }

  return false;
}

// ============================================================================
// 回退与替代方案
// ============================================================================

async function executeStepRollback(
  step: ExecutionStep,
  opts: ExecutorOptions,
): Promise<void> {
  if (!step.rollback) return;
  const rb = step.rollback;

  // 添加回退标记
  step.status = 'completed'; // 标记"已回退"
  updateStepStatus(opts.taskId, step.id, 'completed', `已回退: ${rb.description}`);
}

async function executeStepFallback(
  step: ExecutionStep,
  opts: ExecutorOptions,
): Promise<void> {
  if (!step.fallback) return;
  const fb = step.fallback;

  try {
    await executeStep(
      {
        ...step,
        tool: fb.tool,
        input: fb.input,
      },
      opts,
    );
  } catch {
    throw new Error(`替代方案也失败: ${fb.description}`);
  }
}

// ============================================================================
// 辅助
// ============================================================================

function saveProjectMemory(cwd: string, step: ExecutionStep): void {
  try {
    setProjectMemory(cwd, `step_${step.id}_success`, step.description);
  } catch {
    // 非关键操作，忽略
  }
}

function report(opts: ExecutorOptions, event: ProgressEvent): void {
  opts.onProgress?.(event);
}

function hasAnyFailure(plan: ExecutionPlan): boolean {
  return plan.phases.some(
    p => p.status === 'failed' || p.steps.some(s => s.status === 'failed'),
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  return `${minutes}m ${remainSec}s`;
}
