import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runNewTask, resumeTask } from '../../src/engine/orchestrator.js';
import { setChatProvider } from '../../src/ai/client.js';
import { ScriptedProvider } from '../../eval/scripted-provider.js';
import { EvalIO } from '../../eval/eval-io.js';
import type { EvalTask } from '../../eval/types.js';
import { closeDb, getTask } from '../../src/storage/db.js';

let home: string;
let cwd: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoli-orch-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoli-orch-cwd-'));
  process.env.XIAOLI_HOME = home;
});

afterAll(() => {
  setChatProvider(null);
  closeDb();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

const task: EvalTask = {
  id: 'orchestrator-pause',
  name: '问答中断恢复',
  description: '创建 resumed.txt',
  questions: [
    {
      id: 'q-1',
      question: '要创建什么文件？',
      category: '目标定义',
      expectedAnswerType: 'short',
      priority: 'high',
    },
  ],
  answers: ['1. resumed.txt'],
  plan: {
    summary: '创建 resumed.txt',
    phases: [
      {
        phaseId: 'phase-1',
        name: '执行',
        purpose: '创建文件',
        steps: [
          {
            stepId: 'step-1',
            description: '写入 resumed.txt',
            tool: 'write_file',
            input: { filePath: 'resumed.txt', content: 'resumed' },
            riskLevel: 'medium',
            maxAttempts: 1,
            verify: { type: 'file_contains', path: 'resumed.txt', text: 'resumed' },
          },
        ],
      },
    ],
  },
  expected: {
    status: 'completed',
    files: { 'resumed.txt': 'resumed' },
  },
};

describe('编排器暂停/恢复', () => {
  it('问答阶段中断后可以恢复并执行', async () => {
    setChatProvider(new ScriptedProvider({ questions: task.questions, plan: task.plan }));

    const firstIO = new EvalIO({ ...task, answers: [] });
    const first = await runNewTask(task.description, {
      io: firstIO,
      cwd,
      maxRefinementRounds: 1,
    });

    expect(first.status).toBe('paused');
    expect(getTask(first.taskId)?.status).toBe('paused');

    const secondIO = new EvalIO(task);
    const second = await resumeTask(first.taskId, {
      io: secondIO,
      cwd,
      maxRefinementRounds: 1,
    });

    expect(second.status).toBe('completed');
    expect(fs.readFileSync(path.join(cwd, 'resumed.txt'), 'utf-8')).toBe('resumed');
    expect(getTask(first.taskId)?.status).toBe('completed');
  });
});
