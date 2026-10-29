import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExecutionPlan } from '../../src/engine/types.js';
import {
  closeDb,
  createTask,
  getLatestResumableTask,
  getPendingQA,
  getProjectMemory,
  getQA,
  getSteps,
  getTask,
  resetStepsForResume,
  saveQuestions,
  setProjectMemory,
  updateQAAnswer,
  updateStepStatus,
  updateTaskStatus,
  upsertStep,
} from '../../src/storage/db.js';

let home: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoli-db-'));
  process.env.XIAOLI_HOME = home;
});

afterAll(() => {
  closeDb();
  fs.rmSync(home, { recursive: true, force: true });
});

function plan(): ExecutionPlan {
  const now = new Date().toISOString();
  return {
    id: 'plan-test',
    taskDescription: '测试',
    phases: [],
    steps: [],
    status: 'ready',
    createdAt: now,
    updatedAt: now,
    totalSteps: 0,
    completedSteps: 0,
    failedSteps: 0,
    skippedSteps: 0,
    metadata: { sourceQuestions: 1, generatedBy: 'test' },
  };
}

describe('SQLite 持久化', () => {
  it('创建任务是幂等的', () => {
    createTask('task-1', '第一次', '/tmp');
    createTask('task-1', '第二次', '/tmp');
    const task = getTask('task-1');
    expect(task?.description).toBe('第二次');
    expect(task?.status).toBe('questioning');
  });

  it('问题先落库，回答后更新', () => {
    createTask('task-2', '问答', '/tmp');
    const saved = saveQuestions(
      'task-2',
      [
        { id: 'q-1', question: '问题一', category: '测试', expectedAnswerType: 'short', priority: 'high' },
        { id: 'q-2', question: '问题二', category: '测试', expectedAnswerType: 'short', priority: 'medium' },
      ],
      1,
    );
    expect(saved).toHaveLength(2);
    expect(getPendingQA('task-2')).toHaveLength(2);

    updateQAAnswer(Number(saved[0].id), '答案一');
    expect(getPendingQA('task-2')).toHaveLength(1);
    expect(getQA('task-2')[0].answer).toBe('答案一');
  });

  it('保存任务状态和计划', () => {
    createTask('task-3', '状态', '/tmp');
    const p = plan();
    updateTaskStatus('task-3', 'plan_ready', p);
    const task = getTask('task-3');
    expect(task?.status).toBe('plan_ready');
    expect(task?.plan).toContain('plan-test');
  });

  it('写入步骤并支持恢复重置', () => {
    createTask('task-4', '步骤', '/tmp');
    upsertStep('task-4', 'phase-1', 'step-1', 0, '第一步', 'write_file');
    upsertStep('task-4', 'phase-1', 'step-2', 1, '第二步', 'write_file');
    updateStepStatus('task-4', 'step-1', 'failed', undefined, '失败');
    updateStepStatus('task-4', 'step-2', 'skipped', undefined, '用户拒绝执行高危步骤');

    resetStepsForResume('task-4');
    const steps = getSteps('task-4');
    expect(steps.every((s) => s.status === 'pending')).toBe(true);
    expect(steps.every((s) => s.error === null)).toBe(true);
  });

  it('最近可恢复任务', () => {
    createTask('task-5', '可恢复', '/tmp');
    updateTaskStatus('task-5', 'paused');
    expect(getLatestResumableTask()?.id).toBe('task-5');
  });

  it('项目记忆可读写', () => {
    setProjectMemory('/tmp/project', 'techStack', '{"language":"TypeScript"}');
    expect(getProjectMemory('/tmp/project', 'techStack')).toContain('TypeScript');
  });
});
