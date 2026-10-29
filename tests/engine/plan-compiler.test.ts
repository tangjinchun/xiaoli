import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  compilePlan,
  topoSortSteps,
  type RawPlan,
} from '../../src/engine/plan-compiler.js';
import { PlanValidationError } from '../../src/engine/errors.js';

let cwd: string;

beforeAll(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoli-compiler-'));
});

afterAll(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function validPlan(): RawPlan {
  return {
    summary: '测试计划',
    phases: [
      {
        phaseId: 'phase-1',
        name: '执行',
        purpose: '测试',
        steps: [
          {
            stepId: 'step-1',
            description: '写入 a.txt',
            tool: 'write_file',
            input: { filePath: 'a.txt', content: 'a' },
            riskLevel: 'low',
          },
          {
            stepId: 'step-2',
            description: '写入 b.txt',
            tool: 'write_file',
            input: { filePath: 'b.txt', content: 'b' },
            dependsOn: ['step-1'],
          },
        ],
      },
    ],
  };
}

describe('计划编译器', () => {
  it('编译合法计划', () => {
    const plan = compilePlan(validPlan(), '测试', { cwd });
    expect(plan.totalSteps).toBe(2);
    expect(plan.steps[0].tool).toBe('write_file');
    expect(plan.steps[0].input.filePath).toBe('a.txt');
    expect(plan.status).toBe('ready');
  });

  it('按依赖拓扑排序', () => {
    const plan = compilePlan(validPlan(), '测试', { cwd });
    const sorted = topoSortSteps([plan.steps[1], plan.steps[0]]);
    expect(sorted.map((s) => s.id)).toEqual(['step-1', 'step-2']);
  });

  it('拒绝缺少 input 的步骤', () => {
    const raw = validPlan();
    // @ts-expect-error 故意构造非法输入
    raw.phases[0].steps[0].input = undefined;
    expect(() => compilePlan(raw, '测试', { cwd })).toThrow(PlanValidationError);
  });

  it('拒绝未知工具', () => {
    const raw = validPlan();
    raw.phases[0].steps[0].tool = 'teleport';
    expect(() => compilePlan(raw, '测试', { cwd })).toThrow(PlanValidationError);
  });

  it('拒绝循环依赖', () => {
    const raw = validPlan();
    raw.phases[0].steps[0].dependsOn = ['step-2'];
    raw.phases[0].steps[1].dependsOn = ['step-1'];
    expect(() => compilePlan(raw, '测试', { cwd })).toThrow(PlanValidationError);
  });

  it('归一化 toolHints 别名', () => {
    const raw = validPlan();
    raw.phases[0].steps[0].tool = undefined;
    raw.phases[0].steps[0].toolHints = ['shell'];
    raw.phases[0].steps[0].input = { command: 'echo hi' };
    const plan = compilePlan(raw, '测试', { cwd });
    expect(plan.steps[0].tool).toBe('terminal');
  });

  it('工作目录外的写操作被标为高风险', () => {
    const raw = validPlan();
    raw.phases[0].steps[0].input = { filePath: '../outside.txt', content: 'x' };
    const plan = compilePlan(raw, '测试', { cwd });
    expect(plan.steps[0].riskLevel).toBe('high');
  });

  it('限制 maxAttempts 范围', () => {
    const raw = validPlan();
    raw.phases[0].steps[0].maxAttempts = 99;
    const plan = compilePlan(raw, '测试', { cwd });
    expect(plan.steps[0].maxAttempts).toBe(3);
  });

  it('拒绝不安全的 verify 路径', () => {
    const raw = validPlan();
    raw.phases[0].steps[0].verify = { type: 'file_exists', path: '../outside.txt' };
    expect(() => compilePlan(raw, '测试', { cwd })).toThrow(PlanValidationError);
  });
});
