/**
 * 终端交互层。
 *
 * 所有 readline 都支持 AbortSignal：Ctrl+C 会让当前提问返回 null，
 * 编排器据此保存进度并退出，而不是抛出一串堆栈。
 */

import * as readline from 'node:readline';
import type { ExecutionPlan, ExecutionStep, PlanDecision } from '../engine/types.js';
import type { UserIO } from '../engine/orchestrator.js';
import type { ProgressEvent } from '../engine/executor.js';
import { renderPlan } from '../engine/plan-renderer.js';

export interface CliIOOptions {
  signal?: AbortSignal;
  compact?: boolean;
}

export interface CliIO extends UserIO {
  dispose(): void;
}

async function askLine(prompt: string, signal?: AbortSignal): Promise<string | null> {
  if (signal?.aborted) return null;

  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        rl.close();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const onAbort = (): void => done(null);
    signal?.addEventListener('abort', onAbort, { once: true });
    rl.on('SIGINT', () => {
      process.stdout.write('\n');
      done(null);
    });
    rl.on('close', () => done(null));
    rl.question(prompt, (answer) => done(answer));
  });
}

function normalizeDecision(raw: string): PlanDecision | null {
  const value = raw.trim().toLowerCase();
  if (['/confirm', 'confirm', 'y', 'yes', '确认', '执行'].includes(value)) return 'confirm';
  if (['/reject', 'reject', 'n', 'no', '放弃', '取消'].includes(value)) return 'reject';
  if (['/pause', 'pause', '暂停', 'later'].includes(value)) return 'pause';
  return null;
}

function progressPrefix(event: ProgressEvent): string {
  switch (event.type) {
    case 'step_start':
      return '  ▶';
    case 'step_complete':
      return '  ✅';
    case 'step_failed':
      return '  ❌';
    case 'step_skipped':
      return '  ⏭';
    case 'step_retry':
      return '  ↻';
    case 'phase_start':
      return '\n  ──';
    case 'phase_complete':
      return '  ──';
    case 'plan_paused':
      return '\n⏸';
    default:
      return '  ';
  }
}

export function createCliIO(options: CliIOOptions = {}): CliIO {
  const signal = options.signal;

  return {
    async ask(prompt: string): Promise<string | null> {
      return askLine(prompt, signal);
    },

    async confirmPlan(plan: ExecutionPlan): Promise<PlanDecision> {
      console.log(`\n${renderPlan(plan)}`);
      while (true) {
        const answer = await askLine(
          '输入 /confirm 执行，/reject 放弃，/pause 暂停: ',
          signal,
        );
        if (answer === null) return 'pause';
        const decision = normalizeDecision(answer);
        if (decision) return decision;
        console.log('  无法识别。请输入 /confirm、/reject 或 /pause。');
      }
    },

    async confirmDangerous(step: ExecutionStep, reason: string): Promise<boolean> {
      console.log('\n⚠️  高危操作拦截');
      console.log(`   步骤: ${step.description}`);
      console.log(`   工具: ${step.tool}`);
      console.log(`   参数: ${JSON.stringify(step.input).slice(0, 300)}`);
      console.log(`   原因: ${reason.split('\n').join('\n         ')}`);
      console.log('   操作不可回滚时请特别谨慎。');
      const answer = await askLine('输入 "确认执行" 继续，其他任意输入跳过: ', signal);
      return answer?.trim() === '确认执行';
    },

    async askUser(_step: ExecutionStep, prompt: string): Promise<string | null> {
      console.log(`\n❓ ${prompt}`);
      return askLine('> ', signal);
    },

    notify(message: string): void {
      console.log(message);
    },

    onProgress(event: ProgressEvent): void {
      if (event.type === 'plan_complete' || event.type === 'plan_failed') {
        console.log(`\n${event.message}`);
        return;
      }
      if (event.type === 'paused_for_confirm' || event.type === 'paused_for_user') {
        return;
      }
      console.log(`${progressPrefix(event)} ${event.message}`);
    },

    dispose(): void {
      // readline 实例在每次提问后关闭；这里保留扩展点。
    },
  };
}
