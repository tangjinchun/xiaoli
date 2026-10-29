/**
 * 任务编排器。
 *
 * 把 L1 上下文、L2 追问、L3 收束、计划生成、确认门、执行器串起来。
 * CLI 和离线测评共用这一层。
 */

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type {
  AnsweredQuestion,
  ExecutionPlan,
  ExecutionStep,
  PlanDecision,
  QuestionSkeleton,
  TaskStatus,
} from './types.js';
import { buildContext, formatContextForPrompt } from './context-builder.js';
import { generateQuestions } from './question-generator.js';
import { generateRefinementQuestions } from './question-refiner.js';
import { generatePlan } from './plan-generator.js';
import { collectAnswers } from './question-collector.js';
import { execute, type ExecutorResult, type ProgressEvent } from './executor.js';
import { renderPlan } from './plan-renderer.js';
import { rememberProjectContext } from './memory.js';
import { TaskPausedError, UserRejectedError } from './errors.js';
import { assertTransition } from './conversation.js';
import { hasAIProvider } from '../ai/client.js';
import {
  createTask,
  getQA,
  getTask,
  getTaskPlan,
  getPendingQA,
  saveQuestions,
  updateTaskStatus,
  type QARow,
} from '../storage/db.js';

export interface UserIO {
  ask(prompt: string): Promise<string | null>;
  confirmPlan(plan: ExecutionPlan): Promise<PlanDecision>;
  confirmDangerous(step: ExecutionStep, reason: string): Promise<boolean>;
  askUser(step: ExecutionStep, prompt: string): Promise<string | null>;
  notify(message: string): void;
  onProgress?: (event: ProgressEvent) => void;
}

export interface RunOptions {
  io: UserIO;
  cwd?: string;
  taskId?: string;
  signal?: AbortSignal;
  /** 总轮数（含初始问答）。默认 3；设为 1 表示不做追加追问。 */
  maxRefinementRounds?: number;
  shouldStop?: () => boolean;
}

export interface RunResult {
  taskId: string;
  status: TaskStatus;
  plan?: ExecutionPlan;
  completedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  totalSteps: number;
  error?: string;
}

export async function runNewTask(description: string, opts: RunOptions): Promise<RunResult> {
  if (!hasAIProvider()) {
    throw new Error(
      '未配置 DeepSeek API key。请运行：\n' +
        '  xiaoli config set api.key sk-xxx\n' +
        '或设置环境变量：\n' +
        '  export XIAOLI_API_KEY=sk-xxx',
    );
  }

  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const taskId = opts.taskId ?? generateTaskId();
  createTask(taskId, description, cwd);

  try {
    opts.io.notify(`\n🔨 任务 ${taskId}`);
    opts.io.notify(`   ${description}\n`);

    const contextText = buildContextText(description, cwd, opts.io);
    const maxRounds = Math.max(1, opts.maxRefinementRounds ?? 3);

    opts.io.notify('🤔 生成追问...');
    const questions = await generateQuestions(description, contextText, {
      signal: opts.signal,
    });

    let currentQuestions: QuestionSkeleton[] = [];
    if (questions.length > 0) {
      currentQuestions = saveQuestions(taskId, questions, 1);
      opts.io.notify(`   生成了 ${currentQuestions.length} 个问题\n`);

      const collected = await collectAnswers(currentQuestions, {
        taskId,
        ask: (prompt: string) => opts.io.ask(prompt),
        notify: (message: string) => opts.io.notify(message),
      });
      if (collected.interrupted) {
        return pauseTask(taskId, undefined, '问答已暂停');
      }
    }

    let round = 1;
    const previousGaps: number[] = [];

    while (round < maxRounds) {
      const answered = answeredFromDb(taskId);
      if (answered.length === 0) break;

      opts.io.notify('🔄 检查是否还有信息缺口...');
      const refinement = await generateRefinementQuestions(
        answered,
        currentQuestions,
        {
          round,
          previousRemainingGaps: previousGaps,
          signal: opts.signal,
        },
        { maxRounds, useAI: true },
      );

      if (refinement.canTerminate || refinement.newQuestions.length === 0) {
        opts.io.notify('   ✅ 信息缺口已闭合。\n');
        break;
      }

      opts.io.notify(
        `   还有 ${refinement.remainingGaps} 个缺口，补充 ${refinement.newQuestions.length} 个问题。\n`,
      );
      const saved = saveQuestions(taskId, refinement.newQuestions, round + 1);
      const collected = await collectAnswers(saved, {
        taskId,
        ask: (prompt: string) => opts.io.ask(prompt),
        notify: (message: string) => opts.io.notify(message),
      });
      if (collected.interrupted) {
        return pauseTask(taskId, undefined, '问答已暂停');
      }

      previousGaps.push(refinement.remainingGaps);
      currentQuestions = saved;
      round++;
    }

    return await planAndConfirm(taskId, description, cwd, opts);
  } catch (err) {
    return handleRunError(taskId, opts, err);
  }
}

export async function resumeTask(taskId: string, opts: RunOptions): Promise<RunResult> {
  const task = getTask(taskId);
  if (!task) {
    throw new Error(`任务不存在: ${taskId}`);
  }

  try {
    if (task.status === 'completed' || task.status === 'rejected') {
      opts.io.notify(`任务 ${taskId} 已处于 ${task.status} 状态。`);
      return resultFromTask(taskId, task.status, getTaskPlan(taskId));
    }

    if (task.status === 'questioning') {
      const pending = getPendingQA(taskId);
      if (pending.length > 0) {
        const questions = rowsToQuestions(pending);
        const collected = await collectAnswers(questions, {
          taskId,
          ask: (prompt: string) => opts.io.ask(prompt),
          notify: (message: string) => opts.io.notify(message),
        });
        if (collected.interrupted) {
          return pauseTask(taskId, getTaskPlan(taskId) ?? undefined, '问答已暂停');
        }
      }
      return await planAndConfirm(taskId, task.description, task.cwd, opts);
    }

    if (task.status === 'planning') {
      return await planAndConfirm(taskId, task.description, task.cwd, opts);
    }

    const plan = getTaskPlan(taskId);

    if (task.status === 'plan_ready') {
      if (!plan) {
        return await planAndConfirm(taskId, task.description, task.cwd, opts);
      }
      return await confirmAndExecute(taskId, plan, opts);
    }

    // executing / paused / failed
    if (!plan) {
      // 问答阶段被 Ctrl+C 暂停时，先把剩余问题问完再生成计划。
      const pending = getPendingQA(taskId);
      if (pending.length > 0) {
        const collected = await collectAnswers(rowsToQuestions(pending), {
          taskId,
          ask: (prompt: string) => opts.io.ask(prompt),
          notify: (message: string) => opts.io.notify(message),
        });
        if (collected.interrupted) {
          return pauseTask(taskId, undefined, '问答已暂停');
        }
      }
      return await planAndConfirm(taskId, task.description, task.cwd, opts);
    }

    // 在计划确认门暂停/失败、尚未执行任何步骤时，重新走确认门。
    const allPending = plan.steps.every((step) => step.status === 'pending');
    if (task.status !== 'executing' && allPending) {
      return await confirmAndExecute(taskId, plan, opts);
    }

    transitionTask(taskId, 'executing', plan);
    return await runExecution(taskId, plan, opts, true);
  } catch (err) {
    return handleRunError(taskId, opts, err);
  }
}

// ============================================================================
// 计划阶段
// ============================================================================

async function planAndConfirm(
  taskId: string,
  description: string,
  cwd: string,
  opts: RunOptions,
): Promise<RunResult> {
  transitionTask(taskId, 'planning');
  opts.io.notify('📋 生成执行计划...');

  const answered = answeredFromDb(taskId);
  const plan = await generatePlan(
    answered,
    description,
    {},
    { cwd, signal: opts.signal },
  );

  transitionTask(taskId, 'plan_ready', plan);
  opts.io.notify(renderPlan(plan));

  return await confirmAndExecute(taskId, plan, opts);
}

async function confirmAndExecute(
  taskId: string,
  plan: ExecutionPlan,
  opts: RunOptions,
): Promise<RunResult> {
  const decision = await opts.io.confirmPlan(plan);

  if (opts.signal?.aborted) {
    return pauseTask(taskId, plan, '收到中断');
  }

  if (decision === 'reject') {
    plan.status = 'rejected';
    transitionTask(taskId, 'rejected', plan, '用户拒绝了计划');
    opts.io.notify('已放弃该任务。');
    return resultFromTask(taskId, 'rejected', plan);
  }

  if (decision === 'pause') {
    return pauseTask(taskId, plan, '用户暂停了任务');
  }

  transitionTask(taskId, 'executing', plan);
  return await runExecution(taskId, plan, opts, false);
}

// ============================================================================
// 执行阶段
// ============================================================================

async function runExecution(
  taskId: string,
  plan: ExecutionPlan,
  opts: RunOptions,
  resume: boolean,
): Promise<RunResult> {
  const task = getTask(taskId);
  if (!task) throw new Error(`任务不存在: ${taskId}`);

  const result = await execute(plan, {
    taskId,
    cwd: task.cwd,
    description: task.description,
    signal: opts.signal,
    shouldStop: opts.shouldStop,
    onConfirmDangerous: (step, reason) => opts.io.confirmDangerous(step, reason),
    onAskUser: (step, prompt) => opts.io.askUser(step, prompt),
    onProgress: (event) => opts.io.onProgress?.(event),
    resume,
  });

  return toRunResult(taskId, plan, result);
}

function toRunResult(taskId: string, plan: ExecutionPlan, result: ExecutorResult): RunResult {
  return {
    taskId,
    status: result.paused ? 'paused' : result.success ? 'completed' : 'failed',
    plan,
    completedSteps: result.completedSteps,
    failedSteps: result.failedSteps,
    skippedSteps: result.skippedSteps,
    totalSteps: result.totalSteps,
    error: result.error,
  };
}

function resultFromTask(
  taskId: string,
  status: TaskStatus,
  plan: ExecutionPlan | null,
): RunResult {
  const completed = plan?.completedSteps ?? 0;
  const failed = plan?.failedSteps ?? 0;
  const skipped = plan?.skippedSteps ?? 0;
  const total = plan?.totalSteps ?? 0;
  return {
    taskId,
    status,
    plan: plan ?? undefined,
    completedSteps: completed,
    failedSteps: failed,
    skippedSteps: skipped,
    totalSteps: total,
    error: status === 'failed' ? getTask(taskId)?.error ?? undefined : undefined,
  };
}

// ============================================================================
// 错误 / 暂停
// ============================================================================

function handleRunError(taskId: string, opts: RunOptions, err: unknown): RunResult {
  if (err instanceof TaskPausedError || opts.signal?.aborted) {
    return pauseTask(taskId, getTaskPlan(taskId) ?? undefined, '收到中断');
  }

  if (err instanceof UserRejectedError) {
    const plan = getTaskPlan(taskId) ?? undefined;
    if (plan) plan.status = 'rejected';
    safeUpdateStatus(taskId, 'rejected', plan, err.message);
    opts.io.notify(`已放弃：${err.message}`);
    return resultFromTask(taskId, 'rejected', plan ?? null);
  }

  const message = err instanceof Error ? err.message : String(err);
  const plan = getTaskPlan(taskId) ?? undefined;
  safeUpdateStatus(taskId, 'failed', plan, message);
  opts.io.notify(`\n❌ 任务失败: ${message}`);
  return {
    taskId,
    status: 'failed',
    plan,
    completedSteps: plan?.completedSteps ?? 0,
    failedSteps: plan?.failedSteps ?? 1,
    skippedSteps: plan?.skippedSteps ?? 0,
    totalSteps: plan?.totalSteps ?? 0,
    error: message,
  };
}

function pauseTask(
  taskId: string,
  plan: ExecutionPlan | undefined,
  message: string,
): RunResult {
  const existingPlan = plan ?? getTaskPlan(taskId) ?? undefined;
  if (existingPlan) {
    existingPlan.status = 'paused';
    existingPlan.updatedAt = new Date().toISOString();
  }
  safeUpdateStatus(taskId, 'paused', existingPlan, null);
  return {
    taskId,
    status: 'paused',
    plan: existingPlan,
    completedSteps: existingPlan?.completedSteps ?? 0,
    failedSteps: existingPlan?.failedSteps ?? 0,
    skippedSteps: existingPlan?.skippedSteps ?? 0,
    totalSteps: existingPlan?.totalSteps ?? 0,
    error: message,
  };
}

// ============================================================================
// 辅助
// ============================================================================

function transitionTask(
  taskId: string,
  to: TaskStatus,
  plan?: ExecutionPlan,
  error?: string | null,
): void {
  const task = getTask(taskId);
  if (task) {
    assertTransition(task.status, to);
  }
  updateTaskStatus(taskId, to, plan, error);
}

function safeUpdateStatus(
  taskId: string,
  to: TaskStatus,
  plan?: ExecutionPlan,
  error?: string | null,
): void {
  try {
    const task = getTask(taskId);
    if (task && !task.status.match(/^(completed|rejected)$/)) {
      assertTransition(task.status, to);
    }
    updateTaskStatus(taskId, to, plan, error);
  } catch {
    updateTaskStatus(taskId, to, plan, error);
  }
}

function buildContextText(description: string, cwd: string, io: UserIO): string {
  try {
    io.notify('📖 分析项目上下文...');
    const ctx = buildContext(description, { rootPath: cwd });
    rememberProjectContext(cwd, ctx, description);
    io.notify(
      `   项目类型: ${ctx.projectType} · 文件数: ${ctx.fileCount}` +
        (ctx.relevantFiles.length > 0
          ? ` · 相关文件: ${ctx.relevantFiles.slice(0, 3).join(', ')}`
          : ''),
    );
    return formatContextForPrompt(ctx);
  } catch (err) {
    io.notify(`   上下文分析失败，继续执行: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

function answeredFromDb(taskId: string): AnsweredQuestion[] {
  return getQA(taskId)
    .filter((row) => row.answer !== null || row.skipped === 1)
    .map((row) => ({
      questionId: String(row.id),
      question: row.question,
      answer: row.answer ?? '',
      confidence: row.skipped === 1 || !row.answer ? 'low' : 'high',
      skipped: row.skipped === 1,
      answeredAt: new Date(row.created_at).toISOString(),
    }));
}

function rowsToQuestions(rows: QARow[]): QuestionSkeleton[] {
  return rows.map((row) => ({
    id: String(row.id),
    question: row.question,
    category: '补充信息',
    expectedAnswerType: 'short',
    priority: 'medium',
    round: row.round,
  }));
}

function generateTaskId(): string {
  return `task-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}
