/**
 * 离线演示：不调用真实 DeepSeek，用脚本化模型展示完整链路。
 *
 * 用法：npm run demo
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EVAL_TASKS } from './tasks.js';
import { ScriptedProvider } from './scripted-provider.js';
import { EvalIO } from './eval-io.js';
import { setChatProvider } from '../src/ai/client.js';
import { runNewTask } from '../src/engine/orchestrator.js';
import { closeDb } from '../src/storage/db.js';

async function main(): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoli-demo-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoli-demo-cwd-'));
  process.env.XIAOLI_HOME = home;

  const task = EVAL_TASKS[0];
  console.log('=== xiaoli 离线演示 ===');
  console.log('说明：这里使用脚本化模型，展示问答/计划/确认/执行链路；');
  console.log('     真实使用需要配置 DeepSeek API key。\n');

  setChatProvider(
    new ScriptedProvider({ questions: task.questions, plan: task.plan }),
  );

  try {
    const io = new EvalIO(task, { verbose: true });
    const result = await runNewTask(task.description, {
      io,
      cwd,
      maxRefinementRounds: 1,
    });

    const file = path.join(cwd, 'hello.txt');
    console.log('\n=== 结果 ===');
    console.log(`状态: ${result.status}`);
    if (fs.existsSync(file)) {
      console.log(`hello.txt: ${JSON.stringify(fs.readFileSync(file, 'utf-8'))}`);
    } else {
      console.log('hello.txt 未生成');
    }
    console.log(`任务 ID: ${result.taskId}`);
    console.log('继续体验：xiaoli "你的任务"（需要 API key）');
  } finally {
    setChatProvider(null);
    closeDb();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('演示失败:', err);
  closeDb();
  process.exitCode = 1;
});
