/**
 * Git 操作封装。
 *
 * 会修改仓库的命令全部走 execFile + 参数数组，不经过 shell 字符串拼接，
 * 避免 commit message / 分支名中的引号或 $() 造成命令注入。
 */

import { execFileSync } from 'node:child_process';
import { shellStdout, type ShellOptions } from './shell.js';
import { evaluateGit } from '../safety/policy.js';
import { logSuccess, logBlocked } from '../safety/audit.js';
import {
  ConfirmationRequiredError,
  PolicyDeniedError,
} from '../engine/errors.js';

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  dirty: boolean;
}

export interface GitCommit {
  hash: string;
  message: string;
  date: string;
  author: string;
}

export interface GitCommitResult {
  hash: string;
  message: string;
  filesChanged: number;
}

export interface GitOptions {
  cwd?: string;
  taskId?: string;
  stepId?: string;
  confirmed?: boolean;
}

function runGit(args: string[], opts: GitOptions = {}): string {
  return execFileSync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  }).trim();
}

function guardGit(command: string, opts: GitOptions): void {
  const policy = evaluateGit(command);
  if (policy.verdict === 'STOP') {
    logBlocked(opts.taskId, opts.stepId, 'git', command, 'STOP');
    throw new PolicyDeniedError(`Git 操作被安全策略拒绝: ${command}`, policy.reason);
  }
  if (policy.verdict === 'ASK' && !opts.confirmed) {
    throw new ConfirmationRequiredError(policy.reason, `Git 操作需要确认: ${command}`);
  }
  if (policy.verdict === 'ASK' && opts.confirmed) {
    logSuccess(opts.taskId, opts.stepId, 'git', command, 0);
  }
}

// ============================================================================
// 状态检测
// ============================================================================

export function status(cwd?: string): GitStatus {
  const branch = shellStdout('git rev-parse --abbrev-ref HEAD', { cwd });

  let ahead = 0;
  let behind = 0;
  try {
    const forUpstream = shellStdout('git rev-list --left-right --count origin/HEAD...HEAD', { cwd });
    const [b, a] = forUpstream.split('\t').map(Number);
    behind = b || 0;
    ahead = a || 0;
  } catch {
    // 无上游分支
  }

  const shortStatus = shellStdout('git status --porcelain', { cwd });
  const lines = shortStatus.split('\n').filter(Boolean);

  let staged = 0;
  let modified = 0;
  let untracked = 0;
  for (const line of lines) {
    const idx = line.substring(0, 2);
    if (idx.includes('?') ) {
      untracked++;
      continue;
    }
    if (idx.includes('M') || idx.includes('A') || idx.includes('D') || idx.includes('R')) {
      if (idx[0] !== ' ') staged++;
      if (idx[1] !== ' ') modified++;
    }
  }

  return {
    branch,
    ahead,
    behind,
    staged,
    modified,
    untracked,
    dirty: lines.length > 0,
  };
}

// ============================================================================
// 暂存 / 提交
// ============================================================================

export function add(paths: string[] = ['.'], opts: GitOptions = {}): void {
  const args = ['add', '--', ...paths];
  guardGit(`git ${args.join(' ')}`, opts);
  runGit(args, opts);
  logSuccess(opts.taskId, opts.stepId, 'git', `add ${paths.join(' ')}`, 0);
}

export function commit(message: string, opts: GitOptions = {}): GitCommitResult {
  if (!message.trim()) {
    throw new Error('Git commit 需要非空 message');
  }

  guardGit(`git commit -m ${JSON.stringify(message)}`, opts);

  let stdout = '';
  try {
    stdout = runGit(['commit', '-m', message], opts);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = String(e.stderr ?? e.message ?? '');
    throw new Error(`Git commit 失败: ${stderr}`);
  }

  const hash = runGit(['rev-parse', 'HEAD'], opts).slice(0, 7);
  const filesChanged = parseChangedFiles(stdout);

  logSuccess(opts.taskId, opts.stepId, 'git', `commit: ${message}`, 0);
  return { hash, message, filesChanged };
}

// ============================================================================
// 推送 / 分支
// ============================================================================

export function push(
  opts: GitOptions & { force?: boolean; remote?: string; branch?: string } = {},
): { pushed: boolean; branch: string } {
  const args = ['push'];
  if (opts.force) args.push('--force');
  if (opts.remote) args.push(opts.remote);
  if (opts.branch) args.push(opts.branch);

  const command = `git ${args.join(' ')}`;
  guardGit(command, opts);

  const branch = opts.branch ?? currentBranch(opts.cwd);
  try {
    runGit(args, opts);
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string; message?: string };
    throw new Error(`Git push 失败: ${String(e.stderr ?? e.message ?? '')}`);
  }

  logSuccess(opts.taskId, opts.stepId, 'git', command, 0);
  return { pushed: true, branch };
}

function assertValidBranchName(name: string): void {
  if (!name || name.startsWith('-') || /[\s~^:?*[\\]/.test(name) || name.includes('..')) {
    throw new Error(`非法分支名: ${name}`);
  }
}

export function createBranch(
  name: string,
  opts: GitOptions & { from?: string } = {},
): { name: string } {
  assertValidBranchName(name);
  const args = opts.from ? ['checkout', '-b', name, opts.from] : ['checkout', '-b', name];
  guardGit(`git ${args.join(' ')}`, opts);
  runGit(args, opts);
  logSuccess(opts.taskId, opts.stepId, 'git', `branch ${name}`, 0);
  return { name };
}

export function switchBranch(name: string, opts: GitOptions = {}): void {
  assertValidBranchName(name);
  runGit(['checkout', name], opts);
}

export function currentBranch(cwd?: string): string {
  return shellStdout('git rev-parse --abbrev-ref HEAD', { cwd });
}

// ============================================================================
// 最近提交
// ============================================================================

export function recentCommits(count = 5, cwd?: string): GitCommit[] {
  const format = '%H||%s||%ai||%an';
  const output = runGit(['log', `--format=${format}`, '-n', String(count)], { cwd });
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, message, date, author] = line.split('||');
      return { hash: hash.slice(0, 7), message, date, author };
    });
}

function parseChangedFiles(stdout: string): number {
  const m = stdout.match(/(\d+) files? changed/);
  return m ? parseInt(m[1], 10) : 0;
}

// ============================================================================
// 兼容旧异常名
// ============================================================================

export class GitPushConfirmationRequired extends ConfirmationRequiredError {
  constructor(
    public readonly force: boolean,
    public readonly reason: string,
  ) {
    super(reason, `Git push${force ? ' --force' : ''} 需要用户确认: ${reason}`);
    this.name = 'GitPushConfirmationRequired';
  }
}
