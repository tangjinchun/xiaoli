/**
 * 操作审计
 *
 * 所有 Shell/SQL/File/Git/Env 操作写入 ~/.xiaoli/audit.log。
 * 不依赖数据库（避免循环依赖），纯文件追加。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================================
// 存储路径
// ============================================================================

const AUDIT_DIR = path.join(os.homedir(), '.xiaoli');
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.log');

function ensureDir(): void {
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
  }
}

// ============================================================================
// 日志条目
// ============================================================================

export interface AuditEntry {
  timestamp: string;
  taskId?: string;
  stepId?: string;
  type: 'shell' | 'sql' | 'git' | 'file' | 'env';
  command: string;
  verdict: string;
  exitCode?: number;
  durationMs?: number;
  error?: string;
}

// ============================================================================
// 写入
// ============================================================================

export function log(entry: AuditEntry): void {
  ensureDir();
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(AUDIT_FILE, line, 'utf-8');
}

/**
 * 记录一次成功执行
 */
export function logSuccess(
  taskId: string | undefined,
  stepId: string | undefined,
  type: AuditEntry['type'],
  command: string,
  durationMs: number,
): void {
  log({
    timestamp: new Date().toISOString(),
    taskId,
    stepId,
    type,
    command,
    verdict: 'ALLOW',
    exitCode: 0,
    durationMs,
  });
}

/**
 * 记录一次被拦截的操作
 */
export function logBlocked(
  taskId: string | undefined,
  stepId: string | undefined,
  type: AuditEntry['type'],
  command: string,
  verdict: string,
): void {
  log({
    timestamp: new Date().toISOString(),
    taskId,
    stepId,
    type,
    command,
    verdict,
  });
}

/**
 * 记录一次失败执行
 */
export function logFailure(
  taskId: string | undefined,
  stepId: string | undefined,
  type: AuditEntry['type'],
  command: string,
  exitCode: number,
  error: string,
): void {
  log({
    timestamp: new Date().toISOString(),
    taskId,
    stepId,
    type,
    command,
    verdict: 'ALLOW',
    exitCode,
    error,
  });
}

// ============================================================================
// 读取最近的审计记录
// ============================================================================

export function readRecent(limit = 20): AuditEntry[] {
  ensureDir();
  if (!fs.existsSync(AUDIT_FILE)) return [];

  const content = fs.readFileSync(AUDIT_FILE, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const entries = lines.slice(-limit).map(line => JSON.parse(line) as AuditEntry);
  return entries.reverse();
}
