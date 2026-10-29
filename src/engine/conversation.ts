/**
 * 任务状态机。
 *
 * 只允许明确的状态迁移，避免出现“已完成的任务又被执行”这类问题。
 */

import type { TaskStatus } from './types.js';

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  questioning: ['planning', 'paused', 'failed', 'rejected'],
  planning: ['plan_ready', 'paused', 'failed'],
  plan_ready: ['executing', 'planning', 'paused', 'rejected'],
  executing: ['completed', 'failed', 'paused'],
  paused: ['questioning', 'planning', 'plan_ready', 'executing', 'failed', 'rejected'],
  failed: ['planning', 'plan_ready', 'executing', 'paused', 'rejected'],
  completed: [],
  rejected: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法任务状态迁移: ${from} -> ${to}`);
  }
}

export function nextStatus(
  current: TaskStatus,
  candidates: TaskStatus[],
): TaskStatus | null {
  for (const candidate of candidates) {
    if (canTransition(current, candidate)) return candidate;
  }
  return null;
}
