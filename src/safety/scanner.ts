/**
 * 危险模式扫描器
 *
 * 职责：
 *   1. 每步执行前扫描命令/操作（命令字符串 + 操作类型 + 元数据）
 *   2. 匹配 DANGER_PATTERNS → 判定 STOP/WARN/ASK/ALLOW
 *   3. 按优先级：STOP > ASK > WARN > ALLOW（取最严）
 *   4. FILE 类的批量检查走特殊函数
 */

import {
  DANGER_PATTERNS,
  DangerPattern,
  type SafetyVerdict,
  type ScanResult,
  checkFileBulkDelete,
  checkFileLargePatch,
} from './patterns';

export type { ScanResult };

// ============================================================================
// 扫描输入
// ============================================================================

export interface ScannerInput {
  /** 命令文本（shell 命令 / SQL 语句 / git 命令） */
  command: string;
  /** 操作类型 */
  type: 'shell' | 'sql' | 'git' | 'file' | 'env' | 'readonly';
  /** 额外元数据（FILE 操作时必填） */
  metadata?: {
    /** 要删除的文件数（FILE 操作） */
    deleteFileCount?: number;
    /** 补丁修改的行数（FILE 操作） */
    patchLineCount?: number;
  };
  /** 当前工作目录 */
  cwd?: string;
}

// ============================================================================
// 扫描器
// ============================================================================

export function scan(input: ScannerInput): ScanResult {
  const matches: DangerPattern[] = [];

  // 1. 只读操作 → 直接放行
  if (input.type === 'readonly') {
    return {
      verdict: 'ALLOW',
      matches: [],
      reason: '只读操作，安全放行',
    };
  }

  // 2. 正则匹配
  for (const pattern of DANGER_PATTERNS) {
    if (!pattern.pattern) continue; // 跳过无正则的特殊模式
    if (pattern.pattern.test(input.command)) {
      matches.push(pattern);
    }
  }

  // 3. FILE 特殊检查
  if (input.type === 'file') {
    if (input.metadata?.deleteFileCount) {
      const fileMatch = checkFileBulkDelete(input.metadata.deleteFileCount);
      if (fileMatch) matches.push(fileMatch);
    }
    if (input.metadata?.patchLineCount) {
      const patchMatch = checkFileLargePatch(input.metadata.patchLineCount);
      if (patchMatch) matches.push(patchMatch);
    }
  }

  // 4. 无匹配 → 安全
  if (matches.length === 0) {
    return {
      verdict: 'ALLOW',
      matches: [],
      reason: '未匹配任何危险模式',
    };
  }

  // 5. 取最严厉判定
  const verdict = worstVerdict(matches);

  return {
    verdict,
    matches,
    reason: buildReason(matches, verdict),
  };
}

// ============================================================================
// 判定聚合
// ============================================================================

const VERDICT_PRIORITY: Record<SafetyVerdict, number> = {
  STOP: 0,
  ASK: 1,
  WARN: 2,
  ALLOW: 3,
};

function worstVerdict(matches: DangerPattern[]): SafetyVerdict {
  let worst: SafetyVerdict = 'ALLOW';
  for (const m of matches) {
    if (VERDICT_PRIORITY[m.verdict] < VERDICT_PRIORITY[worst]) {
      worst = m.verdict;
    }
  }
  return worst;
}

// ============================================================================
// 结果描述
// ============================================================================

function buildReason(matches: DangerPattern[], verdict: SafetyVerdict): string {
  const descriptions = matches.map(m => `· ${m.description} (${m.verdict})`);

  switch (verdict) {
    case 'STOP':
      return `拦截：匹配到 ${matches.length} 个危险模式\n${descriptions.join('\n')}`;
    case 'ASK':
      return `需确认：匹配到 ${matches.length} 个需确认模式\n${descriptions.join('\n')}`;
    case 'WARN':
      return `警告：匹配到 ${matches.length} 个风险模式（已放行，已记录审计日志）\n${descriptions.join('\n')}`;
    default:
      return '安全';
  }
}

// ============================================================================
// 便捷函数：针对不同操作类型
// ============================================================================

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
    metadata:
      op === 'delete'
        ? { deleteFileCount: count }
        : { patchLineCount: count },
  });
}

export function scanEnv(command: string): ScanResult {
  return scan({ command, type: 'env' });
}
