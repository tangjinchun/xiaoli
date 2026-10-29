/**
 * 步骤验收。
 *
 * acceptanceCriteria 是自然语言，无法自动判断；但 verify 是确定性检查，
 * 执行器会在工具调用成功后运行它，失败则视为该步骤失败并进入重试。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExecutionStep } from './types.js';
import { VerificationError } from './errors.js';
import { checkPath } from '../safety/policy.js';
import { runCommand } from '../utils/shell.js';

export interface VerifyContext {
  taskId: string;
  stepId: string;
  cwd: string;
  signal?: AbortSignal;
}

function resolvePath(cwd: string, target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(cwd, target);
}

export async function verifyStep(
  step: ExecutionStep,
  output: string,
  ctx: VerifyContext,
): Promise<void> {
  const verify = step.verify;
  if (!verify) return;

  switch (verify.type) {
    case 'file_exists': {
      assertSafePath(ctx.cwd, verify.path);
      const target = resolvePath(ctx.cwd, verify.path);
      if (!fs.existsSync(target)) {
        throw new VerificationError(`验收失败：文件不存在 ${verify.path}`);
      }
      return;
    }
    case 'file_not_exists': {
      assertSafePath(ctx.cwd, verify.path);
      const target = resolvePath(ctx.cwd, verify.path);
      if (fs.existsSync(target)) {
        throw new VerificationError(`验收失败：文件仍然存在 ${verify.path}`);
      }
      return;
    }
    case 'file_contains': {
      assertSafePath(ctx.cwd, verify.path);
      const target = resolvePath(ctx.cwd, verify.path);
      if (!fs.existsSync(target)) {
        throw new VerificationError(`验收失败：文件不存在 ${verify.path}`);
      }
      const content = fs.readFileSync(target, 'utf-8');
      if (!content.includes(verify.text)) {
        throw new VerificationError(
          `验收失败：${verify.path} 不包含 ${JSON.stringify(verify.text)}`,
        );
      }
      return;
    }
    case 'stdout_contains': {
      if (!output.includes(verify.text)) {
        throw new VerificationError(
          `验收失败：输出不包含 ${JSON.stringify(verify.text)}`,
        );
      }
      return;
    }
    case 'command': {
      const result = await runCommand(verify.command, {
        cwd: ctx.cwd,
        taskId: ctx.taskId,
        stepId: ctx.stepId,
        signal: ctx.signal,
        timeout: 60_000,
      });
      const expected = verify.expectedExitCode ?? 0;
      if (result.exitCode !== expected) {
        throw new VerificationError(
          `验收命令退出码 ${result.exitCode}（期望 ${expected}）: ${verify.command}\n${result.stderr.slice(0, 300)}`,
        );
      }
      return;
    }
    default:
      throw new VerificationError(`未知验收类型: ${(verify as { type: string }).type}`);
  }
}

function assertSafePath(cwd: string, target: string): void {
  const policy = checkPath(cwd, target, 'read');
  if (policy.verdict === 'STOP') {
    throw new VerificationError(`验收路径不安全: ${policy.reason}`);
  }
}
