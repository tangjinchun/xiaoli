/**
 * Shell 执行封装。
 *
 * 同步 shell() 供内部短命令使用；异步 runCommand() 供执行器使用，
 * 支持超时、AbortSignal（Ctrl+C 暂停）和统一安全策略。
 */

import { exec, execSync, spawn } from 'node:child_process';
import { evaluateShell } from '../safety/policy.js';
import { logSuccess, logFailure, logBlocked, logConfirmation } from '../safety/audit.js';
import {
  ConfirmationRequiredError,
  PolicyDeniedError,
  TaskPausedError,
} from '../engine/errors.js';

export interface ShellOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  taskId?: string;
  stepId?: string;
  /** 已经过用户确认（用于 ASK 级命令） */
  confirmed?: boolean;
  /** Ctrl+C / 暂停信号 */
  signal?: AbortSignal;
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

const DEFAULT_TIMEOUT = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;

function policyCheck(command: string, opts: ShellOptions): void {
  const policy = evaluateShell(command, opts.cwd ?? process.cwd());
  if (policy.verdict === 'STOP') {
    logBlocked(opts.taskId, opts.stepId, 'shell', command, 'STOP');
    throw new PolicyDeniedError(`命令被安全策略拒绝: ${command}`, policy.reason);
  }
  if (policy.verdict === 'ASK' && !opts.confirmed) {
    throw new ConfirmationRequiredError(policy.reason, `命令需要确认: ${command}`);
  }
  if (policy.verdict === 'ASK' && opts.confirmed) {
    logConfirmation(opts.taskId, opts.stepId, command, true);
  }
}

// ============================================================================
// 同步执行（内部短命令）
// ============================================================================

export function shell(command: string, opts: ShellOptions = {}): ShellResult {
  policyCheck(command, opts);

  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const start = Date.now();

  try {
    const stdout = execSync(command, {
      cwd: opts.cwd,
      timeout,
      env: { ...process.env, ...opts.env },
      encoding: 'utf-8',
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });

    const durationMs = Date.now() - start;
    logSuccess(opts.taskId, opts.stepId, 'shell', command, durationMs);

    return {
      command,
      stdout: stdout.trim(),
      stderr: '',
      exitCode: 0,
      durationMs,
      timedOut: false,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const e = err as {
      killed?: boolean;
      signal?: string;
      code?: string | number;
      status?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    if (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
      logFailure(opts.taskId, opts.stepId, 'shell', command, -1, 'TIMEOUT');
      return {
        command,
        stdout: e.stdout?.trim() ?? '',
        stderr: e.stderr?.trim() ?? '',
        exitCode: -1,
        durationMs,
        timedOut: true,
      };
    }

    logFailure(opts.taskId, opts.stepId, 'shell', command, e.status ?? -1, e.message ?? '');
    return {
      command,
      stdout: e.stdout?.trim() ?? '',
      stderr: e.stderr?.trim() ?? '',
      exitCode: e.status ?? -1,
      durationMs,
      timedOut: false,
    };
  }
}

// ============================================================================
// 异步执行（执行器）
// ============================================================================

export function runCommand(command: string, opts: ShellOptions = {}): Promise<ShellResult> {
  policyCheck(command, opts);

  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const start = Date.now();

  if (opts.signal?.aborted) {
    return Promise.reject(new TaskPausedError());
  }

  return new Promise((resolve, reject) => {
    const child = exec(
      command,
      {
        cwd: opts.cwd,
        timeout,
        env: { ...process.env, ...opts.env },
        encoding: 'utf-8',
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        signal: opts.signal,
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - start;
        const out = String(stdout ?? '').trim();
        const errOut = String(stderr ?? '').trim();

        if (err) {
          const e = err as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: string;
            code?: string | number;
            status?: number;
          };

          if (e.name === 'AbortError' || e.code === 'ABORT_ERR') {
            reject(new TaskPausedError());
            return;
          }

          if (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
            logFailure(opts.taskId, opts.stepId, 'shell', command, -1, 'TIMEOUT');
            resolve({
              command,
              stdout: out,
              stderr: errOut,
              exitCode: -1,
              durationMs,
              timedOut: true,
            });
            return;
          }

          const exitCode = typeof e.status === 'number' ? e.status : typeof e.code === 'number' ? e.code : -1;
          logFailure(opts.taskId, opts.stepId, 'shell', command, exitCode, e.message);
          resolve({
            command,
            stdout: out,
            stderr: errOut,
            exitCode,
            durationMs,
            timedOut: false,
          });
          return;
        }

        logSuccess(opts.taskId, opts.stepId, 'shell', command, durationMs);
        resolve({
          command,
          stdout: out,
          stderr: errOut,
          exitCode: 0,
          durationMs,
          timedOut: false,
        });
      },
    );

    // 防御：有些 Windows 环境不会触发 AbortError，直接监听 signal。
    if (opts.signal) {
      const onAbort = (): void => {
        try {
          child.kill();
        } catch {
          // ignore
        }
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ============================================================================
// 后台执行
// ============================================================================

export function shellBackground(command: string, opts: ShellOptions = {}): BackgroundProcess {
  policyCheck(command, opts);

  const child = spawn(command, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    shell: true,
    windowsHide: true,
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

export function shellStdout(command: string, opts?: ShellOptions): string {
  return shell(command, opts).stdout;
}

export function shellOrThrow(command: string, opts?: ShellOptions): ShellResult {
  const result = shell(command, opts);
  if (result.exitCode !== 0) {
    throw new Error(`命令失败 (exit=${result.exitCode}): ${command}\n${result.stderr}`);
  }
  return result;
}

export function commandExists(cmd: string): boolean {
  try {
    const probe = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
    shell(probe, { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// 兼容旧异常名
// ============================================================================

export class ShellConfirmationRequired extends ConfirmationRequiredError {
  constructor(
    public readonly command: string,
    public readonly reason: string,
  ) {
    super(reason, `需要用户确认: ${command} — ${reason}`);
    this.name = 'ShellConfirmationRequired';
  }
}
