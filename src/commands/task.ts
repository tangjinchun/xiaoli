/**
 * CLI 命令处理器。
 */

import type { TaskStatus } from '../engine/types.js';
import { runNewTask, resumeTask, type RunResult } from '../engine/orchestrator.js';
import { renderPlan } from '../engine/plan-renderer.js';
import { recallProjectContext } from '../engine/memory.js';
import { createCliIO } from '../cli/io.js';
import { hasAIProvider } from '../ai/client.js';
import {
  getLatestResumableTask,
  getLatestTask,
  getQA,
  getSteps,
  getTask,
  getTaskPlan,
} from '../storage/db.js';
import {
  configFilePath,
  getConfigValue,
  listConfig,
  setConfigValue,
} from '../storage/config.js';

function setupInterrupts(controller: AbortController): () => void {
  let count = 0;
  const handler = (): void => {
    count++;
    if (count === 1) {
      console.error('\n收到中断，正在保存进度...');
      controller.abort();
    } else {
      console.error('\n强制退出。');
      process.exit(130);
    }
  };
  process.on('SIGINT', handler);
  return () => process.off('SIGINT', handler);
}

function printRunResult(result: RunResult): number {
  console.log('');
  switch (result.status) {
    case 'completed':
      console.log(
        `🎉 任务完成：${result.completedSteps}/${result.totalSteps} 步成功，${result.skippedSteps} 步跳过。`,
      );
      console.log(`   任务 ID: ${result.taskId}`);
      return 0;
    case 'paused':
      console.log(
        `⏸️ 任务已暂停：${result.completedSteps}/${result.totalSteps} 步完成。`,
      );
      console.log(`   运行 xiaoli continue 继续（任务 ID: ${result.taskId}）。`);
      return 0;
    case 'rejected':
      console.log(`已放弃任务 ${result.taskId}。`);
      return 0;
    case 'failed':
    default:
      console.log(`❌ 任务未完成：${result.completedSteps}/${result.totalSteps} 步成功。`);
      if (result.error) console.log(`   原因: ${result.error}`);
      console.log(`   运行 xiaoli continue 重试（任务 ID: ${result.taskId}）。`);
      return 1;
  }
}

export async function handleTask(description: string): Promise<number> {
  if (!description.trim()) {
    console.log('用法: xiaoli "任务描述"');
    return 1;
  }

  if (!hasAIProvider()) {
    console.error(
      '未配置 DeepSeek API key。\n' +
        '  xiaoli config set api.key sk-xxx\n' +
        '或设置环境变量：\n' +
        '  export XIAOLI_API_KEY=sk-xxx',
    );
    return 1;
  }

  const controller = new AbortController();
  const removeInterrupt = setupInterrupts(controller);
  const io = createCliIO({ signal: controller.signal });

  try {
    console.log(`\n🔨 xiaoli 收到任务: "${description}"`);
    const result = await runNewTask(description, {
      io,
      signal: controller.signal,
      maxRefinementRounds: 3,
    });
    return printRunResult(result);
  } catch (err) {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    io.dispose();
    removeInterrupt();
  }
}

export async function handleContinue(taskId?: string): Promise<number> {
  const task = taskId
    ? getTask(taskId)
    : getLatestResumableTask() ?? getLatestTask();

  if (!task) {
    console.log('没有找到可继续的任务。使用 xiaoli "任务描述" 开始。');
    return 1;
  }

  if (task.status === 'completed' || task.status === 'rejected') {
    console.log(`任务 ${task.id} 已经处于 ${task.status} 状态。`);
    return 0;
  }

  if (!hasAIProvider() && !getTaskPlan(task.id)) {
    console.error(
      '该任务还需要 AI 生成计划，但未配置 DeepSeek API key。\n' +
        '  xiaoli config set api.key sk-xxx',
    );
    return 1;
  }

  const controller = new AbortController();
  const removeInterrupt = setupInterrupts(controller);
  const io = createCliIO({ signal: controller.signal });

  try {
    console.log(`\n▶ 继续任务 ${task.id}（当前状态: ${task.status}）`);
    const result = await resumeTask(task.id, {
      io,
      signal: controller.signal,
      maxRefinementRounds: 3,
    });
    return printRunResult(result);
  } catch (err) {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    io.dispose();
    removeInterrupt();
  }
}

export async function handleStatus(taskId?: string): Promise<number> {
  const task = taskId ? getTask(taskId) : getLatestTask();
  if (!task) {
    console.log(
      taskId ? `任务不存在: ${taskId}` : '还没有任何任务。使用 xiaoli "任务描述" 开始。',
    );
    return taskId ? 1 : 0;
  }

  const qa = getQA(task.id);
  const answered = qa.filter((q) => q.answer !== null && q.skipped === 0).length;
  const skipped = qa.filter((q) => q.skipped === 1).length;
  const pending = qa.filter((q) => q.answer === null && q.skipped === 0).length;
  const plan = getTaskPlan(task.id);
  const steps = getSteps(task.id);

  const memory = recallProjectContext(task.cwd);

  console.log('');
  console.log(`任务: ${task.id}`);
  console.log(`状态: ${statusLabel(task.status)} (${task.status})`);
  console.log(`描述: ${task.description}`);
  console.log(`目录: ${task.cwd}`);
  console.log(`创建: ${new Date(task.created_at).toLocaleString()}`);
  console.log(`更新: ${new Date(task.updated_at).toLocaleString()}`);
  if (memory.lastTask) {
    console.log(`项目记忆: 上次任务「${memory.lastTask}」`);
  }
  console.log(
    `问答: 已回答 ${answered}，跳过 ${skipped}，待回答 ${pending}，共 ${qa.length}`,
  );

  if (plan) {
    console.log(`计划: ${plan.id}（${plan.totalSteps} 步）`);
    console.log('');
    console.log(renderPlan(plan));
    const current = plan.steps.find(
      (s) => s.status === 'running' || s.status === 'pending',
    );
    if (current) {
      console.log(`当前步骤: ${current.id} — ${current.description}`);
    }
  } else if (steps.length > 0) {
    console.log(`步骤: ${steps.length}`);
  }

  if (task.error) {
    console.log(`错误: ${task.error}`);
  }

  if (['paused', 'failed', 'questioning', 'planning', 'plan_ready', 'executing'].includes(task.status)) {
    console.log(`\n运行 xiaoli continue ${task.id} 继续。`);
  }

  return 0;
}

export async function handleConfig(
  action?: string,
  key?: string,
  value?: string,
): Promise<number> {
  const normalizedAction = action?.toLowerCase();

  try {
    if (!normalizedAction || normalizedAction === 'help') {
      printConfigUsage();
      return 0;
    }

    if (normalizedAction === 'path') {
      console.log(configFilePath());
      return 0;
    }

    if (normalizedAction === 'list') {
      const entries = listConfig();
      for (const [k, v] of Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`${k} = ${v}`);
      }
      return 0;
    }

    if (normalizedAction === 'get') {
      if (!key) {
        console.error('用法: xiaoli config get <key>');
        return 1;
      }
      const normalizedKey = normalizeConfigKey(key);
      const result = getConfigValue(normalizedKey);
      if (result === undefined) {
        console.error(`未知配置项: ${normalizedKey}`);
        return 1;
      }
      console.log(`${normalizedKey} = ${result}`);
      return 0;
    }

    if (normalizedAction === 'set') {
      if (!key || value === undefined) {
        console.error('用法: xiaoli config set <key> <value>');
        return 1;
      }
      const normalizedKey = normalizeConfigKey(key);
      setConfigValue(normalizedKey, value);
      const shown =
        normalizedKey === 'api.key'
          ? getConfigValue('api.key')
          : getConfigValue(normalizedKey);
      console.log(`已设置 ${normalizedKey} = ${shown}`);
      return 0;
    }

    console.error(`未知 config 操作: ${normalizedAction}`);
    printConfigUsage();
    return 1;
  } catch (err) {
    console.error(`配置操作失败: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function normalizeConfigKey(key: string): string {
  return key.replace(/^api[-_]/, 'api.').replace(/^safety[-_]/, 'safety.').replace(/^ui[-_]/, 'ui.');
}

function printConfigUsage(): void {
  console.log(`用法:
  xiaoli config set api.key sk-xxx
  xiaoli config get api.key
  xiaoli config list
  xiaoli config path`);
}

export function statusLabel(status: TaskStatus): string {
  const labels: Record<TaskStatus, string> = {
    questioning: '问答中',
    planning: '生成计划中',
    plan_ready: '等待确认',
    executing: '执行中',
    paused: '已暂停',
    completed: '已完成',
    failed: '失败',
    rejected: '已放弃',
  };
  return labels[status];
}
