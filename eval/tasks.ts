/**
 * 10 个离线测评任务。
 *
 * 这些任务不是为了衡量模型智商，而是验证运行时：
 * 问答、计划编译、确认、DAG 执行、重试、安全拦截、ask_user、暂停恢复。
 */

import type { QuestionSkeleton } from '../src/engine/types.js';
import type { RawPlan, RawStep } from '../src/engine/plan-compiler.js';
import type { EvalTask } from './types.js';

function q(
  id: string,
  question: string,
  category = '目标定义',
): QuestionSkeleton {
  return {
    id,
    question,
    category,
    expectedAnswerType: 'short',
    priority: 'high',
  };
}

function plan(summary: string, steps: RawStep[]): RawPlan {
  return {
    summary,
    phases: [
      {
        phaseId: 'phase-1',
        name: '执行',
        purpose: summary,
        steps,
      },
    ],
  };
}

function step(
  stepId: string,
  description: string,
  tool: string,
  input: Record<string, unknown>,
  extra: Partial<RawStep> = {},
): RawStep {
  return {
    stepId,
    description,
    tool,
    input,
    riskLevel: 'low',
    riskReason: '测试任务',
    dependsOn: [],
    acceptanceCriteria: description,
    estimatedTime: '1分钟',
    maxAttempts: 1,
    ...extra,
  };
}

export const EVAL_TASKS: EvalTask[] = [
  {
    id: 'create-file',
    name: '创建文件',
    description: '创建一个 hello.txt，内容为 hello xiaoli',
    questions: [
      q('q-1', '要创建什么文件？'),
      q('q-2', '文件内容是什么？', '成功标准'),
    ],
    answers: ['1. hello.txt 2. hello xiaoli'],
    plan: plan('创建 hello.txt', [
      step('step-1', '写入 hello.txt', 'write_file', {
        filePath: 'hello.txt',
        content: 'hello xiaoli',
      }, {
        riskLevel: 'medium',
        verify: { type: 'file_contains', path: 'hello.txt', text: 'hello xiaoli' },
      }),
    ]),
    expected: {
      status: 'completed',
      files: { 'hello.txt': 'hello xiaoli' },
      qaMin: 2,
    },
  },
  {
    id: 'patch-file',
    name: '精确修改文件',
    description: '把 app.txt 里的 hello world 改成 hello xiaoli',
    files: { 'app.txt': 'hello world' },
    questions: [q('q-1', '要修改哪个文件的哪段内容？')],
    answers: ['1. app.txt 里的 hello world 改成 hello xiaoli'],
    plan: plan('修改 app.txt', [
      step('step-1', '替换 app.txt 文本', 'patch_file', {
        filePath: 'app.txt',
        oldString: 'hello world',
        newString: 'hello xiaoli',
      }, {
        riskLevel: 'medium',
        verify: { type: 'file_contains', path: 'app.txt', text: 'hello xiaoli' },
      }),
    ]),
    expected: {
      status: 'completed',
      files: { 'app.txt': 'hello xiaoli' },
    },
  },
  {
    id: 'run-command',
    name: '执行命令并验收输出',
    description: '运行 check.js，确认输出 ok',
    files: { 'check.js': "console.log('ok')\n" },
    questions: [q('q-1', '运行哪个脚本？')],
    answers: ['1. check.js'],
    plan: plan('运行 check.js', [
      step('step-1', '运行 check.js', 'terminal', {
        command: 'node check.js',
      }, {
        riskLevel: 'low',
        verify: { type: 'stdout_contains', text: 'ok' },
      }),
    ]),
    expected: {
      status: 'completed',
    },
  },
  {
    id: 'reject-plan',
    name: '拒绝执行计划',
    description: '创建一个 rejected.txt',
    questions: [q('q-1', '要创建什么文件？')],
    answers: ['1. rejected.txt'],
    planDecision: 'reject',
    plan: plan('创建 rejected.txt', [
      step('step-1', '写入 rejected.txt', 'write_file', {
        filePath: 'rejected.txt',
        content: 'should not exist',
      }),
    ]),
    expected: {
      status: 'rejected',
      fileAbsent: ['rejected.txt'],
    },
  },
  {
    id: 'pause-resume',
    name: '执行暂停与恢复',
    description: '依次创建 one.txt 和 two.txt',
    questions: [q('q-1', '要创建哪些文件？')],
    answers: ['1. one.txt 和 two.txt'],
    stopAfterStep: 1,
    resumeAfterStop: true,
    plan: plan('创建两个文件', [
      step('step-1', '写入 one.txt', 'write_file', {
        filePath: 'one.txt',
        content: 'one',
      }),
      step('step-2', '写入 two.txt', 'write_file', {
        filePath: 'two.txt',
        content: 'two',
      }),
    ]),
    expected: {
      status: 'completed',
      firstRunStatus: 'paused',
      files: { 'one.txt': 'one', 'two.txt': 'two' },
    },
  },
  {
    id: 'blocked-rm-outside',
    name: '拦截工作目录外删除',
    description: '删除一个工作目录外的临时文件',
    outsideFile: true,
    questions: [q('q-1', '要删除哪个文件？')],
    answers: ['1. 工作目录外的临时文件'],
    plan: plan('危险删除', [
      step('step-1', '递归删除外部文件', 'terminal', {
        command: 'rm -rf {{OUTSIDE_FILE}}',
      }),
    ]),
    expected: {
      status: 'failed',
      errorContains: '任务未完成',
    },
  },
  {
    id: 'high-risk-confirm',
    name: '高危步骤确认后执行',
    description: '写入一个高风险文件',
    dangerousConfirm: true,
    questions: [q('q-1', '要写入什么文件？')],
    answers: ['1. high-risk.txt'],
    plan: plan('高危写入', [
      step('step-1', '写入 high-risk.txt', 'write_file', {
        filePath: 'high-risk.txt',
        content: 'approved',
      }, {
        riskLevel: 'high',
        riskReason: '测试高危确认流程',
        verify: { type: 'file_contains', path: 'high-risk.txt', text: 'approved' },
      }),
    ]),
    expected: {
      status: 'completed',
      files: { 'high-risk.txt': 'approved' },
    },
  },
  {
    id: 'ask-user',
    name: '执行中询问用户',
    description: '询问用户要写入的内容，然后写入 answer.txt',
    askUserAnswers: ['blue'],
    questions: [q('q-1', '要写入哪个文件？')],
    answers: ['1. answer.txt'],
    plan: plan('询问后写入', [
      step('step-1', '询问写入内容', 'ask_user', {
        prompt: '请输入要写入的内容',
      }),
      step('step-2', '写入 answer.txt', 'write_file', {
        filePath: 'answer.txt',
        content: '{{step-1}}',
      }, {
        dependsOn: ['step-1'],
        verify: { type: 'file_contains', path: 'answer.txt', text: 'blue' },
      }),
    ]),
    expected: {
      status: 'completed',
      files: { 'answer.txt': 'blue' },
    },
  },
  {
    id: 'retry',
    name: '失败重试',
    description: '运行一个第一次失败、第二次成功的脚本',
    files: {
      'flaky.js': `const fs = require('fs');
if (!fs.existsSync('.marker')) {
  fs.writeFileSync('.marker', '1');
  console.error('first failure');
  process.exit(1);
}
console.log('ok');
`,
    },
    questions: [q('q-1', '运行哪个脚本？')],
    answers: ['1. flaky.js'],
    plan: plan('重试脚本', [
      step('step-1', '运行 flaky.js', 'terminal', {
        command: 'node flaky.js',
      }, {
        maxAttempts: 2,
        verify: { type: 'stdout_contains', text: 'ok' },
      }),
    ]),
    expected: {
      status: 'completed',
      sawRetry: true,
    },
  },
  {
    id: 'refinement',
    name: '多轮追问',
    description: '创建一个内容明确的文件',
    maxRefinementRounds: 2,
    questions: [
      q('q-1', '目标是什么？'),
      q('q-2', '验收标准是什么？', '成功标准'),
    ],
    refinement: {
      questions: [q('q-refine-1', '文件内容具体是什么？', '成功标准')],
      remaining_gaps: 1,
      can_terminate: false,
      reasons: ['缺少数值/内容级别的验收标准'],
    },
    answers: ['1. 做个文件 2. 能用就行', '1. 内容是 hello refine'],
    plan: plan('创建 refined.txt', [
      step('step-1', '写入 refined.txt', 'write_file', {
        filePath: 'refined.txt',
        content: 'hello refine',
      }, {
        verify: { type: 'file_contains', path: 'refined.txt', text: 'hello refine' },
      }),
    ]),
    expected: {
      status: 'completed',
      files: { 'refined.txt': 'hello refine' },
      qaMin: 3,
    },
  },
];
