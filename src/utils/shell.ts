/**
 * Shell 执行封装
 *
 * 职责：
 *   · 安全执行 Shell 命令（扫描 → 执行 → 审计）
 *   · 捕获 stdout / stderr / exitCode
 *   · 超时控制
 *   · 后台执行 + notify
 */

import { execSync, exec, spawn } from 'node:child_process';
import { scanShell } from '../safety/scanner';
import { logSuccess, logFailure, logBlocked } from '../safety/audit';

// ============================================================================
// 类型
// ============================================================================

export interface ShellOptions {
  /** 工作目录 */
  cwd?: string;
  /** 超时（ms），默认 30_000 */
  timeout?: number;
  /** 环境变量覆盖 */
  env?: Record<string, string>;
  /** 任务追踪 */
  taskId?: string;
  stepId?: string;
}

export interface ShellResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

export interface BackgroundProcess {
  pid: number;
  sessionId: string;
  command: string;
}

// ============================================================================
// 同步执行（推荐：简单命令）
// ============================================================================

export function shell(command: string, opts: ShellOptions = {}): ShellResult {
  const { cwd, timeout = 30_000, taskId, stepId } = opts;

  // 1. 安全扫描
  const scanResult = scanShell(command, cwd);
  if (scanResult.verdict === 'STOP') {
    logBlocked(taskId, stepId, 'shell', command, 'STOP');
    throw new Error(`命令被拦截: ${scanResult.reason}`);
  }
  if (scanResult.verdict === 'ASK') {
    // 需要用户确认——这里抛出明确标记，由 executor 处理
    throw new ShellConfirmationRequired(command, scanResult.reason);
  }

  // 2. 执行
  const start = Date.now();
  try {
    const stdout = execSync(command, {
      cwd,
      timeout,
      env: { ...process.env, ...opts.env },
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    const durationMs = Date.now() - start;
    logSuccess(taskId, stepId, 'shell', command, durationMs);

    return {
      command,
      stdout: stdout.trim(),
      stderr: '',
      exitCode: 0,
      durationMs,
      timedOut: false,
    };
  } catch (err: any) {
    const durationMs = Date.now() - start;

    if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
      logFailure(taskId, stepId, 'shell', command, -1, 'TIMEOUT');
      return {
        command,
        stdout: err.stdout?.trim() ?? '',
        stderr: err.stderr?.trim() ?? '',
        exitCode: -1,
        durationMs,
        timedOut: true,
      };
    }

    logFailure(taskId, stepId, 'shell', command, err.status ?? -1, err.message);
    return {
      command,
      stdout: err.stdout?.trim() ?? '',
      stderr: err.stderr?.trim() ?? '',
      exitCode: err.status ?? -1,
      durationMs,
      timedOut: false,
    };
  }
}

// ============================================================================
// 后台执行（长时间任务）
// ============================================================================

export function shellBackground(
  command: string,
  opts: ShellOptions = {},
): BackgroundProcess {
  const { cwd } = opts;

  const child = spawn('sh', ['-c', command], {
    cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  child.unref();

  return {
    pid: child.pid!,
    sessionId: `bg-${child.pid}-${Date.now()}`,
    command,
  };
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 执行并只返回 stdout（忽略 stderr）
 */
export function shellStdout(command: string, opts?: ShellOptions): string {
  return shell(command, opts).stdout;
}

/**
 * 执行并检查 exitCode=0，否则抛异常
 */
export function shellOrThrow(command: string, opts?: ShellOptions): ShellResult {
  const result = shell(command, opts);
  if (result.exitCode !== 0) {
    throw new Error(
      `命令失败 (exit=${result.exitCode}): ${command}\n${result.stderr}`,
    );
  }
  return result;
}

/**
 * 检查某个命令是否存在
 */
export function commandExists(cmd: string): boolean {
  try {
    shell(`which ${cmd}`, { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// 自定义异常
// ============================================================================

export class ShellConfirmationRequired extends Error {
  constructor(
    public readonly command: string,
    public readonly reason: string,
  ) {
    super(`需要用户确认: ${command} — ${reason}`);
    this.name = 'ShellConfirmationRequired';
  }
}
