#!/usr/bin/env node

/**
 * xiaoli CLI — 主入口。
 *
 * 完整管线：L1 上下文 → L2 追问 → L3 收束 → 计划 → 确认 → 执行
 */

import { Command } from 'commander';
import {
  handleConfig,
  handleContinue,
  handleStatus,
  handleTask,
} from './commands/task.js';

const program = new Command();

program
  .name('xiaoli')
  .description('xiaoli — 先问完再执行的终端 AI 同事')
  .version('0.2.0')
  .showHelpAfterError();

program
  .command('task')
  .description('启动新任务（等价于直接输入任务描述）')
  .argument('<description...>', '任务描述')
  .action(async (parts: string[]) => {
    process.exitCode = await handleTask(parts.join(' '));
  });

program
  .command('status')
  .description('查看任务进度')
  .argument('[taskId]', '任务 ID；不传则查看最近任务')
  .action(async (taskId?: string) => {
    process.exitCode = await handleStatus(taskId);
  });

program
  .command('continue')
  .description('继续最近暂停/未完成的任务')
  .argument('[taskId]', '任务 ID；不传则继续最近的可恢复任务')
  .action(async (taskId?: string) => {
    process.exitCode = await handleContinue(taskId);
  });

program
  .command('config')
  .description('查看或修改配置')
  .argument('[action]', 'set | get | list | path')
  .argument('[key]', '配置项，如 api.key')
  .argument('[value]', '配置值')
  .action(async (action?: string, key?: string, value?: string) => {
    process.exitCode = await handleConfig(action, key, value);
  });

program
  .argument('[description...]', '任务描述')
  .description('启动新任务')
  .action(async (parts: string[]) => {
    if (!parts || parts.length === 0) {
      program.help();
      return;
    }
    process.exitCode = await handleTask(parts.join(' '));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`xiaoli 运行失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
