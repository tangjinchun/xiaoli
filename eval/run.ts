/**
 * 离线测评运行器。
 *
 * 用法：npm run eval
 *
 * 每个任务在独立临时目录里运行；数据库和配置隔离到临时 XIAOLI_HOME。
 * 不调用真实 DeepSeek，因此结果可重复、无网络、无费用。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EVAL_TASKS } from './tasks.js';
import { ScriptedProvider } from './scripted-provider.js';
import { EvalIO } from './eval-io.js';
import type { EvalTask } from './types.js';
import { runNewTask, resumeTask, type RunResult } from '../src/engine/orchestrator.js';
import { setChatProvider } from '../src/ai/client.js';
import { closeDb, getQA, getTask } from '../src/storage/db.js';
import type { RawPlan } from '../src/engine/plan-compiler.js';

interface EvalOutcome {
  id: string;
  name: string;
  pass: boolean;
  status: string;
  durationMs: number;
  issues: string[];
}

function replaceOutsideFile(value: unknown, outsidePath?: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{OUTSIDE_FILE\}\}/g, outsidePath ?? '');
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceOutsideFile(item, outsidePath));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = replaceOutsideFile(item, outsidePath);
    }
    return result;
  }
  return value;
}

function materializePlan(task: EvalTask, outsidePath?: string): RawPlan {
  return replaceOutsideFile(
    JSON.parse(JSON.stringify(task.plan)),
    outsidePath,
  ) as RawPlan;
}

function createWorkspace(task: EvalTask): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `xiaoli-eval-${task.id}-`));
  for (const [file, content] of Object.entries(task.files ?? {})) {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf-8');
  }
  return cwd;
}

function assertFile(cwd: string, file: string, expected: string, issues: string[]): void {
  const target = path.join(cwd, file);
  if (!fs.existsSync(target)) {
    issues.push(`文件不存在: ${file}`);
    return;
  }
  const actual = fs.readFileSync(target, 'utf-8');
  if (actual !== expected) {
    issues.push(`${file} 内容不匹配: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

async function runOne(task: EvalTask): Promise<EvalOutcome> {
  const started = Date.now();
  const issues: string[] = [];
  const cwd = createWorkspace(task);
  const outsidePath = task.outsideFile
    ? path.join(os.tmpdir(), `xiaoli-eval-outside-${process.pid}-${task.id}.txt`)
    : undefined;

  if (outsidePath) {
    fs.writeFileSync(outsidePath, 'victim', 'utf-8');
  }

  try {
    const provider = new ScriptedProvider({
      questions: task.questions,
      plan: materializePlan(task, outsidePath),
      refinement: task.refinement,
    });
    setChatProvider(provider);

    const io = new EvalIO(task, { stopAfterStep: task.stopAfterStep });
    let result: RunResult = await runNewTask(task.description, {
      io,
      cwd,
      maxRefinementRounds: task.maxRefinementRounds ?? 1,
      shouldStop: () => io.shouldStop(),
    });

    if (task.expected.firstRunStatus) {
      if (result.status !== task.expected.firstRunStatus) {
        issues.push(`首次运行状态应为 ${task.expected.firstRunStatus}，实际 ${result.status}`);
      }
    }

    if (task.resumeAfterStop) {
      const resumeIO = new EvalIO(task);
      setChatProvider(provider);
      result = await resumeTask(result.taskId, {
        io: resumeIO,
        cwd,
        maxRefinementRounds: 1,
      });
    }

    if (result.status !== task.expected.status) {
      issues.push(`最终状态应为 ${task.expected.status}，实际 ${result.status}`);
    }

    for (const [file, expected] of Object.entries(task.expected.files ?? {})) {
      assertFile(cwd, file, expected, issues);
    }

    for (const file of task.expected.fileAbsent ?? []) {
      if (fs.existsSync(path.join(cwd, file))) {
        issues.push(`文件不应存在: ${file}`);
      }
    }

    if (task.expected.errorContains) {
      const dbError = getTask(result.taskId)?.error ?? '';
      const combined = `${result.error ?? ''}\n${dbError}`;
      if (!combined.includes(task.expected.errorContains)) {
        issues.push(`错误信息不包含 ${JSON.stringify(task.expected.errorContains)}: ${combined.slice(0, 200)}`);
      }
    }

    if (task.expected.qaMin !== undefined) {
      const qaCount = getQA(result.taskId).length;
      if (qaCount < task.expected.qaMin) {
        issues.push(`问答条数应 >= ${task.expected.qaMin}，实际 ${qaCount}`);
      }
    }

    if (task.expected.sawRetry) {
      if (!io.progress.some((e) => e.type === 'step_retry')) {
        issues.push('没有观察到步骤重试事件');
      }
    }

    if (outsidePath && !fs.existsSync(outsidePath)) {
      issues.push('工作目录外的文件被删除了（安全策略失效）');
    }

    return {
      id: task.id,
      name: task.name,
      pass: issues.length === 0,
      status: result.status,
      durationMs: Date.now() - started,
      issues,
    };
  } catch (err) {
    issues.push(err instanceof Error ? err.message : String(err));
    return {
      id: task.id,
      name: task.name,
      pass: false,
      status: 'error',
      durationMs: Date.now() - started,
      issues,
    };
  } finally {
    setChatProvider(null);
    fs.rmSync(cwd, { recursive: true, force: true });
    if (outsidePath) fs.rmSync(outsidePath, { force: true });
  }
}

async function main(): Promise<void> {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoli-eval-home-'));
  process.env.XIAOLI_HOME = tempHome;

  console.log('\n=== xiaoli 离线运行时测评 ===');
  console.log(`任务数: ${EVAL_TASKS.length} · 数据目录: ${tempHome}\n`);

  const outcomes: EvalOutcome[] = [];
  for (const task of EVAL_TASKS) {
    process.stdout.write(`▶ ${task.id} ... `);
    const outcome = await runOne(task);
    outcomes.push(outcome);
    console.log(
      outcome.pass ? 'PASS' : 'FAIL',
      `(${outcome.status}, ${outcome.durationMs}ms)`,
    );
    for (const issue of outcome.issues) {
      console.log(`    - ${issue}`);
    }
  }

  const passed = outcomes.filter((o) => o.pass).length;
  console.log('\n=== 结果 ===');
  console.log('ID                     结果   状态       耗时    说明');
  console.log('─'.repeat(72));
  for (const o of outcomes) {
    console.log(
      `${o.id.padEnd(22)} ${o.pass ? 'PASS' : 'FAIL'}   ${o.status.padEnd(10)} ${String(o.durationMs).padStart(5)}ms  ${o.name}`,
    );
  }
  console.log('─'.repeat(72));
  console.log(`通过: ${passed}/${outcomes.length}`);

  closeDb();
  fs.rmSync(tempHome, { recursive: true, force: true });

  if (passed !== outcomes.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n测评运行失败:', err);
  closeDb();
  process.exitCode = 1;
});
