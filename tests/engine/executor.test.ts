import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compilePlan, type RawPlan } from '../../src/engine/plan-compiler.js';
import { execute } from '../../src/engine/executor.js';
import { closeDb, getTask } from '../../src/storage/db.js';
import type { ProgressEvent } from '../../src/engine/executor.js';

let home: string;
let cwd: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoli-exec-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoli-exec-cwd-'));
  process.env.XIAOLI_HOME = home;
});

afterAll(() => {
  closeDb();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function rawPlan(steps: RawPlan['phases'] extends unknown ? any[] : never): RawPlan {
  return {
    summary: '测试',
    phases: [
      {
        phaseId: 'phase-1',
        name: '执行',
        purpose: '测试',
        steps,
      },
    ],
  };
}

function writeStep(id: string, file: string, content: string, extra: Record<string, unknown> = {}) {
  return {
    stepId: id,
    description: `写入 ${file}`,
    tool: 'write_file',
    input: { filePath: file, content },
    riskLevel: 'medium',
    maxAttempts: 1,
    verify: { type: 'file_contains', path: file, text: content },
    ...extra,
  };
}

describe('执行器', () => {
  it('执行写文件并通过验收', async () => {
    const plan = compilePlan(rawPlan([writeStep('s1', 'a.txt', 'alpha')]), '测试', { cwd });
    const result = await execute(plan, {
      taskId: 'exec-1',
      cwd,
      description: '测试',
    });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf-8')).toBe('alpha');
    expect(getTask('exec-1')?.status).toBe('completed');
  });

  it('失败后真正重试', async () => {
    fs.writeFileSync(
      path.join(cwd, 'flaky.js'),
      `const fs=require('fs');
if (!fs.existsSync('.marker')) { fs.writeFileSync('.marker','1'); process.exit(1); }
console.log('ok');
`,
    );
    const plan = compilePlan(
      rawPlan([
        {
          stepId: 's1',
          description: '运行 flaky.js',
          tool: 'terminal',
          input: { command: 'node flaky.js' },
          riskLevel: 'low',
          maxAttempts: 2,
          verify: { type: 'stdout_contains', text: 'ok' },
        },
      ]),
      '测试',
      { cwd },
    );

    const events: ProgressEvent[] = [];
    const result = await execute(plan, {
      taskId: 'exec-2',
      cwd,
      description: '测试',
      onProgress: (e) => events.push(e),
    });

    expect(result.success).toBe(true);
    expect(events.some((e) => e.type === 'step_retry')).toBe(true);
  });

  it('暂停后可以从剩余步骤恢复', async () => {
    const plan = compilePlan(
      rawPlan([writeStep('s1', 'one.txt', 'one'), writeStep('s2', 'two.txt', 'two')]),
      '测试',
      { cwd },
    );

    let stop = false;
    let completed = 0;
    const first = await execute(plan, {
      taskId: 'exec-3',
      cwd,
      description: '测试',
      shouldStop: () => stop,
      onProgress: (e) => {
        if (e.type === 'step_complete') {
          completed++;
          if (completed >= 1) stop = true;
        }
      },
    });

    expect(first.paused).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'one.txt'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'two.txt'))).toBe(false);
    expect(getTask('exec-3')?.status).toBe('paused');

    const second = await execute(plan, {
      taskId: 'exec-3',
      cwd,
      description: '测试',
      resume: true,
      shouldStop: () => false,
    });

    expect(second.success).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'two.txt'))).toBe(true);
    expect(getTask('exec-3')?.status).toBe('completed');
  });

  it('高危步骤被拒绝时不执行', async () => {
    const plan = compilePlan(
      rawPlan([writeStep('s1', 'high.txt', 'nope', { riskLevel: 'high' })]),
      '测试',
      { cwd },
    );

    const result = await execute(plan, {
      taskId: 'exec-4',
      cwd,
      description: '测试',
      onConfirmDangerous: async () => false,
    });

    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'high.txt'))).toBe(false);
    expect(plan.steps[0].status).toBe('skipped');
  });

  it('高危步骤确认后执行', async () => {
    const plan = compilePlan(
      rawPlan([writeStep('s1', 'high-ok.txt', 'yes', { riskLevel: 'high' })]),
      '测试',
      { cwd },
    );

    const result = await execute(plan, {
      taskId: 'exec-5',
      cwd,
      description: '测试',
      onConfirmDangerous: async () => true,
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(cwd, 'high-ok.txt'), 'utf-8')).toBe('yes');
  });

  it('安全策略 STOP 时不落盘', async () => {
    const plan = compilePlan(
      rawPlan([
        {
          stepId: 's1',
          description: '写入工作目录外',
          tool: 'write_file',
          input: { filePath: '../outside.txt', content: 'x' },
          riskLevel: 'low',
        },
      ]),
      '测试',
      { cwd },
    );

    const outside = path.join(path.dirname(cwd), 'outside.txt');
    fs.rmSync(outside, { force: true });

    const result = await execute(plan, {
      taskId: 'exec-6',
      cwd,
      description: '测试',
      onConfirmDangerous: async () => true,
    });

    expect(result.success).toBe(false);
    expect(fs.existsSync(outside)).toBe(false);
  });
});
