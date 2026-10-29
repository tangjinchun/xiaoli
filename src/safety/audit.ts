/**
 * 操作审计。
 *
 * 所有 Shell/SQL/File/Git/Env 操作写入审计日志（默认 ~/.xiaoli/audit.log）。
 * 日志中的 API key、token、password 会被脱敏。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getAuditPath, ensureXiaoliHome } from '../storage/paths.js';
import { loadConfig } from '../storage/config.js';

export interface AuditEntry {
  timestamp: string;
  taskId?: string;
  stepId?: string;
  type: 'shell' | 'sql' | 'git' | 'file' | 'env' | 'policy' | 'task';
  command: string;
  verdict: string;
  exitCode?: number;
  durationMs?: number;
  error?: string;
  confirmed?: boolean;
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function auditFilePath(): string {
  const configured = loadConfig().safety.auditLogPath;
  return configured ? expandHome(configured) : getAuditPath();
}

export function redact(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-****')
    .replace(/((?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*)["']?[^\s"',;]+/gi, '$1****')
    .replace(/(authorization:\s*bearer\s+)[^\s"',;]+/gi, '$1****');
}

export function log(entry: AuditEntry): void {
  try {
    ensureXiaoliHome();
    const target = auditFilePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const safe: AuditEntry = {
      ...entry,
      command: redact(entry.command),
      error: entry.error ? redact(entry.error) : undefined,
    };
    fs.appendFileSync(target, JSON.stringify(safe) + '\n', 'utf-8');
  } catch {
    // 审计失败不能阻塞主流程；但会静默丢失记录。
  }
}

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
    verdict: 'ERROR',
    exitCode,
    error,
  });
}

export function logPolicy(
  taskId: string | undefined,
  stepId: string | undefined,
  type: AuditEntry['type'],
  command: string,
  verdict: string,
  reason: string,
): void {
  log({
    timestamp: new Date().toISOString(),
    taskId,
    stepId,
    type,
    command,
    verdict,
    error: reason,
  });
}

export function logConfirmation(
  taskId: string | undefined,
  stepId: string | undefined,
  command: string,
  confirmed: boolean,
): void {
  log({
    timestamp: new Date().toISOString(),
    taskId,
    stepId,
    type: 'policy',
    command,
    verdict: confirmed ? 'CONFIRMED' : 'DECLINED',
    confirmed,
  });
}

export function readRecent(limit = 20): AuditEntry[] {
  try {
    const target = auditFilePath();
    if (!fs.existsSync(target)) return [];
    const content = fs.readFileSync(target, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => JSON.parse(line) as AuditEntry)
      .reverse();
  } catch {
    return [];
  }
}
