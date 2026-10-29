/**
 * 危险模式扫描器（兼容旧 API）。
 *
 * 真正的判定逻辑在 policy.ts；这里把统一策略的结果映射成旧的
 * ALLOW / WARN / ASK / STOP 结构，供现有工具层和测试使用。
 */

import {
  type DangerCategory,
  type DangerPattern,
  type SafetyVerdict,
  type ScanResult,
  checkFileBulkDelete,
  checkFileLargePatch,
} from './patterns.js';
import {
  evaluateGit,
  evaluateShell,
  evaluateSql,
  type PolicyMatch,
  type PolicyResult,
} from './policy.js';

export type { ScanResult };

export interface ScannerInput {
  /** 命令文本（shell 命令 / SQL 语句 / git 命令） */
  command: string;
  /** 操作类型 */
  type: 'shell' | 'sql' | 'git' | 'file' | 'env' | 'readonly';
  /** 额外元数据（FILE 操作时必填） */
  metadata?: {
    deleteFileCount?: number;
    patchLineCount?: number;
  };
  /** 当前工作目录 */
  cwd?: string;
}

function categoryFor(type: ScannerInput['type']): DangerCategory {
  switch (type) {
    case 'sql':
      return 'SQL';
    case 'git':
      return 'GIT';
    case 'file':
      return 'FILE';
    case 'env':
      return 'ENV';
    default:
      return 'SHELL';
  }
}

function toDangerPatterns(matches: PolicyMatch[], category: DangerCategory): DangerPattern[] {
  return matches.map((m) => ({
    category,
    pattern: /policy/,
    description: m.description,
    verdict: m.verdict,
  }));
}

function fromPolicy(policy: PolicyResult, category: DangerCategory): ScanResult {
  if (policy.matches.length === 0) {
    return { verdict: 'ALLOW', matches: [], reason: '未匹配任何危险模式' };
  }
  return {
    verdict: policy.verdict,
    matches: toDangerPatterns(policy.matches, category),
    reason:
      policy.verdict === 'STOP'
        ? `拦截：${policy.reason}`
        : policy.verdict === 'ASK'
          ? `需确认：${policy.reason}`
          : policy.verdict === 'WARN'
            ? `警告：${policy.reason}`
            : '安全',
  };
}

export function scan(input: ScannerInput): ScanResult {
  if (input.type === 'readonly') {
    return { verdict: 'ALLOW', matches: [], reason: '只读操作，安全放行' };
  }

  const category = categoryFor(input.type);

  if (input.type === 'file') {
    const matches: DangerPattern[] = [];
    if (input.metadata?.deleteFileCount) {
      const fileMatch = checkFileBulkDelete(input.metadata.deleteFileCount);
      if (fileMatch) matches.push(fileMatch);
    }
    if (input.metadata?.patchLineCount) {
      const patchMatch = checkFileLargePatch(input.metadata.patchLineCount);
      if (patchMatch) matches.push(patchMatch);
    }

    if (matches.length === 0) {
      return { verdict: 'ALLOW', matches: [], reason: '文件操作未命中阈值' };
    }
    let verdict: SafetyVerdict = 'ALLOW';
    for (const m of matches) {
      if (m.verdict === 'STOP') verdict = 'STOP';
      else if (m.verdict === 'ASK' && verdict !== 'STOP') verdict = 'ASK';
      else if (m.verdict === 'WARN' && verdict === 'ALLOW') verdict = 'WARN';
    }
    return {
      verdict,
      matches,
      reason: matches.map((m) => `· ${m.description} (${m.verdict})`).join('\n'),
    };
  }

  const policy =
    input.type === 'sql'
      ? evaluateSql(input.command)
      : input.type === 'git'
        ? evaluateGit(input.command)
        : evaluateShell(input.command, input.cwd ?? process.cwd());

  return fromPolicy(policy, category);
}

export function scanShell(command: string, cwd?: string): ScanResult {
  return scan({ command, type: 'shell', cwd });
}

export function scanSql(query: string): ScanResult {
  return scan({ command: query, type: 'sql' });
}

export function scanGit(command: string): ScanResult {
  return scan({ command, type: 'git' });
}

export function scanFile(op: 'delete' | 'patch', count: number): ScanResult {
  return scan({
    command: `file-${op}`,
    type: 'file',
    metadata: op === 'delete' ? { deleteFileCount: count } : { patchLineCount: count },
  });
}

export function scanEnv(command: string): ScanResult {
  return scan({ command, type: 'env' });
}
