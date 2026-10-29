/**
 * 执行器。
 *
 * 职责：
 *   1. 按依赖关系（DAG）执行计划
 *   2. 每步执行前过统一安全策略；ASK/HIGH 风险要求确认
 *   3. 每步执行后跑确定性验收
 *   4. 失败真正重试，重试耗尽后尝试 fallback / rollback
 *   5. 每步状态写入 SQLite，支持 Ctrl+C 暂停和 continue 恢复
 */

import type {
  ExecutionPlan,
  ExecutionPhase,
  ExecutionStep,
  TaskStatus,
  ToolName,
} from './types.js';
import {
  createTask,
  updateTaskStatus,
  upsertStep,
  updateStepStatus,
  incrementStepRecovery,
  resetStepsForResume,
  setProjectMemory,
} from '../storage/db.js';
import { evaluateToolCall } from '../safety/policy.js';
import {
  logConfirmation,
  logFailure,
  logPolicy,
  logSuccess,
} from '../safety/audit.js';
import { getTool } from './tool-registry.js';
import { topoSortSteps } from './plan-compiler.js';
import { verifyStep } from './verifier.js';
import {
  ConfirmationRequiredError,
  PolicyDeniedError,
  TaskPausedError,
  ToolExecutionError,
} from './errors.js';

export interface ExecutorOptions {
  taskId: string;
  cwd: string;
  description: string;
  /** 中断信号（Ctrl+C） */
  signal?: AbortSignal;
  /** 自定义停止判断，测评用来模拟暂停 */
  shouldStop?: () => boolean;
  /** 高危操作确认：返回 true 才执行 */
  onConfirmDangerous?: (step: ExecutionStep, reason: string) => Promise<boolean>;
  /** ask_user 工具 */
  onAskUser?: (step: ExecutionStep, prompt: string) => Promise<string | null>;
  onProgress?: (event: ProgressEvent) => void;
  onPhaseComplete?: (phase: ExecutionPhase) => void;
  /** 覆盖步骤的 maxAttempts */
  maxRetries?: number;
  /** 从暂停/失败状态恢复 */
  resume?: boolean;
}

export type ProgressEventType =
  | 'phase_start'
  | 'phase_complete'
  | 'step_start'
  | 'step_complete'
  | 'step_failed'
  | 'step_skipped'
  | 'step_retry'
  | 'plan_complete'
  | 'plan_failed'
  | 'plan_paused'
  | 'paused_for_confirm'
  | 'paused_for_user';

export interface ProgressEvent {
  type: ProgressEventType;
  phase?: ExecutionPhase;
  step?: ExecutionStep;
  message: string;
  timestamp: string;
}

export interface ExecutorResult {
  success: boolean;
  paused: boolean;
  status: 'completed' | 'failed' | 'paused';
  planId: string;
  completedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  totalSteps: number;
  durationMs: number;
  error?: string;
}

interface Counters {
  completed: number;
  failed: number;
  skipped: number;
}

export async function execute(
  plan: ExecutionPlan,
  opts: ExecutorOptions,
): Promise<ExecutorResult> {
  const startTime = Date.now();
  const counters: Counters = { completed: 0, failed: 0, skipped: 0 };
  const totalSteps = plan.steps.length;

  createTask(opts.taskId, opts.description, opts.cwd);

  if (opts.resume) {
    resetPlanForResume(plan);
    resetStepsForResume(opts.taskId);
  }

  for (const phase of plan.phases) {
    for (const step of phase.steps) {
      upsertStep(
        opts.taskId,
        phase.id,
        step.id,
        plan.steps.indexOf(step),
        step.description,
        step.tool,
      );
    }
  }

  plan.status = 'running';
  persist(opts, plan, 'executing');

  const ordered = topoSortSteps(plan.steps);
  const results = new Map<string, string>();
  for (const step of plan.steps) {
    if (step.status === 'completed' && step.result !== undefined) {
      results.set(step.id, step.result);
      counters.completed++;
    }
    if (step.status === 'skipped') counters.skipped++;
  }

  const startedPhases = new Set<string>();
  const completedPhases = new Set<string>();
  let declinedDangerous = false;
  let hardDenied = false;

  for (const step of ordered) {
    if (step.status === 'completed' || step.status === 'skipped') {
      maybeCompletePhase(step.phaseId, plan, opts, completedPhases);
      continue;
    }

    if (shouldPause(opts)) {
      return pausePlan(plan, opts, startTime, counters, '收到中断，已保存进度');
    }

    const phase = plan.phases.find((p) => p.id === step.phaseId);

    if (phase && !startedPhases.has(phase.id)) {
      startedPhases.add(phase.id);
      phase.status = 'running';
      report(opts, {
        type: 'phase_start',
        phase,
        message: `开始阶段: ${phase.name}`,
        timestamp: new Date().toISOString(),
      });
    }

    // 依赖失败/跳过 → 本步跳过
    const blockedDep = step.dependsOn.find((depId) => {
      const dep = plan.steps.find((s) => s.id === depId);
      return dep?.status === 'failed' || dep?.status === 'skipped';
    });
    if (blockedDep) {
      step.status = 'skipped';
      step.error = `依赖步骤未完成: ${blockedDep}`;
      step.completedAt = new Date().toISOString();
      counters.skipped++;
      updateStepStatus(opts.taskId, step.id, 'skipped', undefined, step.error);
      report(opts, {
        type: 'step_skipped',
        phase,
        step,
        message: `⏭️ 跳过 ${step.description}: 依赖 ${blockedDep} 未完成`,
        timestamp: new Date().toISOString(),
      });
      persist(opts, plan, 'executing');
      maybeCompletePhase(step.phaseId, plan, opts, completedPhases);
      continue;
    }

    step.status = 'running';
    step.startedAt = new Date().toISOString();
    step.updatedAt = step.startedAt;
    step.error = undefined;
    updateStepStatus(opts.taskId, step.id, 'running');
    persist(opts, plan, 'executing');

    report(opts, {
      type: 'step_start',
      phase,
      step,
      message: `▶ ${step.description} [${step.tool}]`,
      timestamp: new Date().toISOString(),
    });

    const policy = evaluateToolCall(step.tool, step.input, opts.cwd);
    logPolicy(
      opts.taskId,
      step.id,
      'policy',
      JSON.stringify({ tool: step.tool, input: step.input }),
      policy.verdict,
      policy.reason,
    );

    if (policy.verdict === 'STOP') {
      const error = `安全策略拒绝: ${policy.reason}`;
      step.status = 'failed';
      step.error = error;
      step.completedAt = new Date().toISOString();
      counters.failed++;
      hardDenied = true;
      if (phase) phase.status = 'failed';
      updateStepStatus(opts.taskId, step.id, 'failed', undefined, error);
      report(opts, {
        type: 'step_failed',
        phase,
        step,
        message: `⛔ ${step.description}: ${error}`,
        timestamp: new Date().toISOString(),
      });
      persist(opts, plan, 'executing');
      break;
    }

    let confirmed = false;
    const needsConfirm = policy.verdict === 'ASK' || step.riskLevel === 'high';

    if (needsConfirm) {
      const reason = [step.riskReason, policy.reason].filter(Boolean).join('\n');
      report(opts, {
        type: 'paused_for_confirm',
        phase,
        step,
        message: `⚠️ 高危步骤需要确认: ${step.description}\n${reason}`,
        timestamp: new Date().toISOString(),
      });

      if (!opts.onConfirmDangerous) {
        const error = '需要确认，但没有可用的确认通道（fail-closed）';
        step.status = 'failed';
        step.error = error;
        step.completedAt = new Date().toISOString();
        counters.failed++;
        hardDenied = true;
        if (phase) phase.status = 'failed';
        updateStepStatus(opts.taskId, step.id, 'failed', undefined, error);
        report(opts, {
          type: 'step_failed',
          phase,
          step,
          message: `⛔ ${step.description}: ${error}`,
          timestamp: new Date().toISOString(),
        });
        persist(opts, plan, 'executing');
        break;
      }

      const approved = await opts.onConfirmDangerous(step, reason);
      logConfirmation(
        opts.taskId,
        step.id,
        JSON.stringify({ tool: step.tool, input: step.input }),
        approved,
      );

      if (!approved) {
        step.status = 'skipped';
        step.error = '用户拒绝执行高危步骤';
        step.completedAt = new Date().toISOString();
        counters.skipped++;
        declinedDangerous = true;
        updateStepStatus(opts.taskId, step.id, 'skipped', undefined, step.error);
        report(opts, {
          type: 'step_skipped',
          phase,
          step,
          message: `⏭️ 用户拒绝执行: ${step.description}`,
          timestamp: new Date().toISOString(),
        });
        persist(opts, plan, 'executing');
        maybeCompletePhase(step.phaseId, plan, opts, completedPhases);
        continue;
      }

      confirmed = true;
    }

    const maxAttempts = Math.max(1, opts.maxRetries ?? step.maxAttempts ?? 1);
    let completed = false;
    let lastError = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (shouldPause(opts)) {
        return pausePlan(plan, opts, startTime, counters, '收到中断，已保存进度');
      }

      step.attempts++;
      incrementStepRecovery(opts.taskId, step.id);

      try {
        const resolvedInput = resolveTemplates(step.input, results) as Record<string, unknown>;
        const output = await runAction(
          step.tool,
          resolvedInput,
          step,
          opts,
          confirmed,
        );

        await verifyStep(step, output, {
          taskId: opts.taskId,
          stepId: step.id,
          cwd: opts.cwd,
          signal: opts.signal,
        });

        step.status = 'completed';
        step.result = output;
        step.error = undefined;
        step.completedAt = new Date().toISOString();
        step.updatedAt = step.completedAt;
        counters.completed++;
        results.set(step.id, output);

        updateStepStatus(opts.taskId, step.id, 'completed', output);
        persist(opts, plan, 'executing');

        if (step.tool === 'terminal') {
          try {
            setProjectMemory(opts.cwd, `last_command:${step.id}`, step.description);
          } catch {
            // 记忆不是关键路径
          }
        }

        report(opts, {
          type: 'step_complete',
          phase,
          step,
          message: `✅ ${step.description}${output ? ` — ${output.slice(0, 120)}` : ''}`,
          timestamp: new Date().toISOString(),
        });

        completed = true;
        break;
      } catch (err: unknown) {
        if (err instanceof TaskPausedError || opts.signal?.aborted || shouldPause(opts)) {
          step.status = 'pending';
          step.updatedAt = new Date().toISOString();
          updateStepStatus(opts.taskId, step.id, 'pending');
          return pausePlan(plan, opts, startTime, counters, '收到中断，已保存进度');
        }

        if (err instanceof ConfirmationRequiredError) {
          if (opts.onConfirmDangerous) {
            const approved = await opts.onConfirmDangerous(step, err.reason);
            if (approved) {
              confirmed = true;
              continue;
            }
          }
          lastError = err.message;
            break;
        }

        lastError = err instanceof Error ? err.message : String(err);
        const detail = err instanceof ToolExecutionError
          ? [err.message, err.stderr, err.stdout].filter(Boolean).join('\n').slice(0, 800)
          : lastError;

        logFailure(opts.taskId, step.id, 'shell', JSON.stringify(step.input), -1, detail);
        step.error = detail;

        if (attempt < maxAttempts) {
          report(opts, {
            type: 'step_retry',
            phase,
            step,
            message: `↻ ${step.description} 失败，第 ${attempt}/${maxAttempts} 次尝试，准备重试: ${detail.slice(0, 160)}`,
            timestamp: new Date().toISOString(),
          });
          await sleep(300, opts.signal);
        }
      }
    }

    if (!completed) {
      // 尝试替代方案
      if (step.fallback) {
        try {
          const fallbackInput = resolveTemplates(step.fallback.input, results) as Record<string, unknown>;
          const fallbackPolicy = evaluateToolCall(step.fallback.tool, fallbackInput, opts.cwd);
          if (fallbackPolicy.verdict === 'STOP') {
            throw new PolicyDeniedError('替代方案被安全策略拒绝', fallbackPolicy.reason);
          }
          if (fallbackPolicy.verdict === 'ASK' && !confirmed) {
            throw new ConfirmationRequiredError(fallbackPolicy.reason);
          }
          const output = await runAction(
            step.fallback.tool,
            fallbackInput,
            step,
            opts,
            confirmed,
          );
          await verifyStep(step, output, {
            taskId: opts.taskId,
            stepId: step.id,
            cwd: opts.cwd,
            signal: opts.signal,
          });

          step.status = 'completed';
          step.result = output;
          step.error = undefined;
          step.completedAt = new Date().toISOString();
          counters.completed++;
          results.set(step.id, output);
          updateStepStatus(opts.taskId, step.id, 'completed', `替代方案: ${output}`);
          persist(opts, plan, 'executing');
          report(opts, {
            type: 'step_complete',
            phase,
            step,
            message: `🔄 替代方案成功: ${step.description}`,
            timestamp: new Date().toISOString(),
          });
          completed = true;
        } catch (fallbackErr) {
          const message = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          step.error = `${lastError}\n替代方案失败: ${message}`;
        }
      }

      if (!completed) {
        // 回退操作（尽力而为）
        if (step.rollback) {
          try {
            const rollbackInput = resolveTemplates(step.rollback.input, results) as Record<string, unknown>;
            const rollbackPolicy = evaluateToolCall(step.rollback.tool, rollbackInput, opts.cwd);
            if (rollbackPolicy.verdict !== 'STOP') {
              await runAction(step.rollback.tool, rollbackInput, step, opts, confirmed);
              report(opts, {
                type: 'step_complete',
                phase,
                step,
                message: `↩️ 已执行回退: ${step.rollback.description}`,
                timestamp: new Date().toISOString(),
              });
            }
          } catch (rollbackErr) {
            report(opts, {
              type: 'step_failed',
              phase,
              step,
              message: `⚠️ 回退失败: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
              timestamp: new Date().toISOString(),
            });
          }
        }

        step.status = 'failed';
        step.error = step.error ?? lastError;
        step.completedAt = new Date().toISOString();
        counters.failed++;
        if (phase) phase.status = 'failed';
        updateStepStatus(opts.taskId, step.id, 'failed', undefined, step.error);
        report(opts, {
          type: 'step_failed',
          phase,
          step,
          message: `❌ ${step.description}: ${(step.error ?? '').slice(0, 240)}`,
          timestamp: new Date().toISOString(),
        });
        persist(opts, plan, 'executing');
        break;
      }
    }

    maybeCompletePhase(step.phaseId, plan, opts, completedPhases);
  }

  const failed = plan.steps.some((s) => s.status === 'failed') || hardDenied || declinedDangerous;
  const status: Extract<TaskStatus, 'completed' | 'failed'> = failed ? 'failed' : 'completed';

  plan.status = status;
  plan.completedSteps = counters.completed;
  plan.failedSteps = counters.failed;
  plan.skippedSteps = counters.skipped;
  plan.completedAt = new Date().toISOString();
  plan.updatedAt = plan.completedAt;

  updateTaskStatus(opts.taskId, status, plan, failed ? '任务未完成' : null);

  const durationMs = Date.now() - startTime;
  report(opts, {
    type: failed ? 'plan_failed' : 'plan_complete',
    message: failed
      ? `⚠️ 未完成：${counters.completed} 成功 / ${counters.failed} 失败 / ${counters.skipped} 跳过，耗时 ${formatDuration(durationMs)}`
      : `🎉 全部完成：${counters.completed} 成功 / ${counters.skipped} 跳过，耗时 ${formatDuration(durationMs)}`,
    timestamp: new Date().toISOString(),
  });

  return {
    success: !failed,
    paused: false,
    status,
    planId: plan.id,
    completedSteps: counters.completed,
    failedSteps: counters.failed,
    skippedSteps: counters.skipped,
    totalSteps,
    durationMs,
    error: failed ? '任务未完成' : undefined,
  };
}

// ============================================================================
// 单步执行
// ============================================================================

async function runAction(
  toolName: ToolName,
  input: Record<string, unknown>,
  step: ExecutionStep,
  opts: ExecutorOptions,
  confirmed: boolean,
): Promise<string> {
  const tool = getTool(toolName);
  if (!tool) {
    throw new ToolExecutionError(`未知工具: ${toolName}`);
  }

  const issues = tool.validate(input);
  if (issues.length > 0) {
    throw new ToolExecutionError(`工具参数不合法: ${issues.join('; ')}`);
  }

  const result = await tool.execute(input, {
    taskId: opts.taskId,
    stepId: step.id,
    cwd: opts.cwd,
    signal: opts.signal,
    confirmed,
    askUser: async (prompt: string) => {
      report(opts, {
        type: 'paused_for_user',
        step,
        message: `❓ 需要你回答: ${prompt}`,
        timestamp: new Date().toISOString(),
      });
      if (!opts.onAskUser) {
        throw new ToolExecutionError('ask_user 没有可用的用户输入通道');
      }
      const answer = await opts.onAskUser(step, prompt);
      if (answer === null) throw new TaskPausedError();
      return answer;
    },
  });

  return result.output;
}

// ============================================================================
// 暂停 / 恢复
// ============================================================================

function shouldPause(opts: ExecutorOptions): boolean {
  return opts.signal?.aborted === true || opts.shouldStop?.() === true;
}

function pausePlan(
  plan: ExecutionPlan,
  opts: ExecutorOptions,
  startTime: number,
  counters: Counters,
  message: string,
): ExecutorResult {
  for (const step of plan.steps) {
    if (step.status === 'running') {
      step.status = 'paused';
      step.updatedAt = new Date().toISOString();
      updateStepStatus(opts.taskId, step.id, 'paused');
    }
  }

  plan.status = 'paused';
  plan.completedSteps = counters.completed;
  plan.failedSteps = counters.failed;
  plan.skippedSteps = counters.skipped;
  plan.updatedAt = new Date().toISOString();
  updateTaskStatus(opts.taskId, 'paused', plan, null);

  report(opts, {
    type: 'plan_paused',
    message: `⏸️ ${message}。运行 xiaoli continue 继续。`,
    timestamp: new Date().toISOString(),
  });

  return {
    success: false,
    paused: true,
    status: 'paused',
    planId: plan.id,
    completedSteps: counters.completed,
    failedSteps: counters.failed,
    skippedSteps: counters.skipped,
    totalSteps: plan.steps.length,
    durationMs: Date.now() - startTime,
    error: message,
  };
}

function resetPlanForResume(plan: ExecutionPlan): void {
  for (const step of plan.steps) {
    const deniedByUser =
      step.status === 'skipped' && (step.error ?? '').includes('用户拒绝');
    if (
      step.status === 'running' ||
      step.status === 'paused' ||
      step.status === 'failed' ||
      deniedByUser
    ) {
      step.status = 'pending';
      step.error = undefined;
      step.completedAt = undefined;
      step.attempts = 0;
    }
  }
  plan.status = 'pending';
}

function persist(opts: ExecutorOptions, plan: ExecutionPlan, status: TaskStatus): void {
  plan.updatedAt = new Date().toISOString();
  updateTaskStatus(opts.taskId, status, plan, null);
}

// ============================================================================
// 辅助
// ============================================================================

function maybeCompletePhase(
  phaseId: string,
  plan: ExecutionPlan,
  opts: ExecutorOptions,
  completedPhases: Set<string>,
): void {
  if (completedPhases.has(phaseId)) return;
  const phase = plan.phases.find((p) => p.id === phaseId);
  if (!phase) return;

  const terminal = phase.steps.every((s) =>
    ['completed', 'failed', 'skipped'].includes(s.status),
  );
  if (!terminal) return;

  phase.status = phase.steps.some((s) => s.status === 'failed') ? 'failed' : 'completed';
  completedPhases.add(phaseId);
  report(opts, {
    type: 'phase_complete',
    phase,
    message: `阶段完成: ${phase.name} (${phase.status})`,
    timestamp: new Date().toISOString(),
  });
  opts.onPhaseComplete?.(phase);
}

function resolveTemplates(value: unknown, results: Map<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{([^}]+)\}\}/g, (_, rawKey: string) => {
      const key = rawKey.trim();
      const result = results.get(key);
      if (result === undefined) {
        throw new Error(`模板变量未找到: {{${key}}}（依赖步骤尚未完成）`);
      }
      return result;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplates(item, results));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = resolveTemplates(item, results);
    }
    return result;
  }
  return value;
}

function report(opts: ExecutorOptions, event: ProgressEvent): void {
  opts.onProgress?.(event);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TaskPausedError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new TaskPausedError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  return `${minutes}m ${remainSec}s`;
}
