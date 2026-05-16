/**
 * Git 操作封装
 *
 * 职责：commit / push / branch 管理 / 状态检测
 */

import { shellStdout, shell, type ShellOptions } from './shell';
import { scanGit } from '../safety/scanner';
import { logSuccess, logBlocked } from '../safety/audit';

// ============================================================================
// 类型
// ============================================================================

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
    // 无上游分支，忽略
  }

  const shortStatus = shellStdout('git status --porcelain', { cwd });
  const lines = shortStatus.split('\n').filter(Boolean);

  let staged = 0, modified = 0, untracked = 0;
  for (const line of lines) {
    const idx = line.substring(0, 2);
    if (idx.includes('M') || idx.includes('A') || idx.includes('D') || idx.includes('R')) {
      if (idx[0] !== ' ') staged++;
      if (idx[1] !== ' ') modified++;
    }
    if (idx.includes('?')) untracked++;
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
// 提交
// ============================================================================

export function commit(
  message: string,
  opts?: { cwd?: string; taskId?: string; stepId?: string },
): GitCommitResult {
  // 安全扫描
  const scanResult = scanGit(`git commit -m "${message}"`);
  if (scanResult.verdict === 'STOP') {
    logBlocked(opts?.taskId, opts?.stepId, 'git', `commit: ${message}`, 'STOP');
    throw new Error(`Git commit 被拦截: ${scanResult.reason}`);
  }

  const result = shell(`git commit -m "${message}"`, { cwd: opts?.cwd });

  if (result.exitCode !== 0) {
    throw new Error(`Git commit 失败: ${result.stderr}`);
  }

  const hash = getLastCommitHash(opts?.cwd);
  const filesChanged = parseChangedFiles(result.stdout);

  logSuccess(opts?.taskId, opts?.stepId, 'git', `commit: ${message}`, result.durationMs);

  return { hash, message, filesChanged };
}

// ============================================================================
// 推送
// ============================================================================

export function push(
  opts?: { cwd?: string; force?: boolean; taskId?: string; stepId?: string },
): { pushed: boolean; branch: string } {
  const cmd = opts?.force ? 'git push --force' : 'git push';
  const scanResult = scanGit(cmd);

  if (scanResult.verdict === 'STOP') {
    logBlocked(opts?.taskId, opts?.stepId, 'git', cmd, 'STOP');
    throw new Error(`Git push 被拦截: ${scanResult.reason}`);
  }
  if (scanResult.verdict === 'ASK') {
    // 由 executor 处理确认
    throw new GitPushConfirmationRequired(
      opts?.force ?? false,
      scanResult.reason,
    );
  }

  const branch = shellStdout('git rev-parse --abbrev-ref HEAD', { cwd: opts?.cwd });
  const result = shell(cmd, { cwd: opts?.cwd });

  if (result.exitCode !== 0) {
    throw new Error(`Git push 失败: ${result.stderr}`);
  }

  logSuccess(opts?.taskId, opts?.stepId, 'git', cmd, result.durationMs);
  return { pushed: true, branch };
}

// ============================================================================
// 分支管理
// ============================================================================

export function createBranch(
  name: string,
  opts?: { cwd?: string; from?: string },
): { name: string } {
  shellStdout(`git checkout -b ${name}`, { cwd: opts?.cwd });
  return { name };
}

export function switchBranch(name: string, cwd?: string): void {
  shellStdout(`git checkout ${name}`, { cwd });
}

export function currentBranch(cwd?: string): string {
  return shellStdout('git rev-parse --abbrev-ref HEAD', { cwd });
}

// ============================================================================
// 最近提交
// ============================================================================

export function recentCommits(count = 5, cwd?: string): GitCommit[] {
  const log = shellStdout(
    `git log --oneline --format="%H||%s||%ai||%an" -n ${count}`,
    { cwd },
  );
  return log.split('\n').filter(Boolean).map(line => {
    const [hash, message, date, author] = line.split('||');
    return { hash: hash.slice(0, 7), message, date, author };
  });
}

function getLastCommitHash(cwd?: string): string {
  return shellStdout('git rev-parse HEAD', { cwd }).slice(0, 7);
}

function parseChangedFiles(stdout: string): number {
  const m = stdout.match(/(\d+) files? changed/);
  return m ? parseInt(m[1], 10) : 0;
}

// ============================================================================
// 自定义异常
// ============================================================================

export class GitPushConfirmationRequired extends Error {
  constructor(
    public readonly force: boolean,
    public readonly reason: string,
  ) {
    super(`Git push${force ? ' --force' : ''} 需要用户确认: ${reason}`);
    this.name = 'GitPushConfirmationRequired';
  }
}
