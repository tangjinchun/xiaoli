/**
 * 危险模式库
 *
 * 5 大类危险操作模式定义：
 *   SHELL — 不可逆的文件系统/权限操作
 *   SQL   — 破坏性数据库操作
 *   GIT   — 不可逆的版本历史操作
 *   FILE  — 大规模文件删除
 *   ENV   — 系统级配置修改
 */

// ============================================================================
// 类型
// ============================================================================

export type DangerCategory = 'SHELL' | 'SQL' | 'GIT' | 'FILE' | 'ENV';

export type SafetyVerdict =
  | 'ALLOW'  // 安全，放行
  | 'WARN'   // 警告但放行（记录审计日志）
  | 'ASK'    // 需要用户确认
  | 'STOP';  // 拦截，禁止执行

export interface DangerPattern {
  category: DangerCategory;
  /** 正则匹配模式 */
  pattern: RegExp;
  /** 人类可读的描述 */
  description: string;
  /** 匹配后的判定 */
  verdict: SafetyVerdict;
}

export interface ScanResult {
  verdict: SafetyVerdict;
  /** 匹配到的危险模式（空 = 安全） */
  matches: DangerPattern[];
  /** 人类可读的解释 */
  reason: string;
}

// ============================================================================
// 危险模式定义
// ============================================================================

export const DANGER_PATTERNS: DangerPattern[] = [
  // --- SHELL ---
  {
    category: 'SHELL',
    pattern: /\brm\s+-rf\b/,
    description: '递归强制删除文件/目录',
    verdict: 'STOP',
  },
  {
    category: 'SHELL',
    pattern: /\bsudo\s+rm\b/,
    description: '以 root 权限删除文件',
    verdict: 'STOP',
  },
  {
    category: 'SHELL',
    pattern: /\bchmod\s+777\b/,
    description: '将文件权限设为 777（所有人可读写执行）',
    verdict: 'STOP',
  },
  {
    category: 'SHELL',
    pattern: />\s*\/dev\/sda/,
    description: '直接写入磁盘设备（可能损坏分区表）',
    verdict: 'STOP',
  },
  {
    category: 'SHELL',
    pattern: /\bdd\s+if=/,
    description: 'dd 磁盘操作',
    verdict: 'STOP',
  },
  {
    category: 'SHELL',
    pattern: /\bmkfs\./,
    description: '格式化文件系统',
    verdict: 'STOP',
  },
  {
    category: 'SHELL',
    pattern: /\bsudo\s+(su|bash|sh)\b/,
    description: '切换为 root shell',
    verdict: 'ASK',
  },
  {
    category: 'SHELL',
    pattern: /\bcurl\b.*\|\s*(ba)?sh\b/,
    description: 'curl 管道到 shell 执行（无审查）',
    verdict: 'ASK',
  },
  {
    category: 'SHELL',
    pattern: /\bnpm\s+(-g|--global)\s+(uninstall|remove)/,
    description: '全局卸载 npm 包',
    verdict: 'WARN',
  },
  {
    category: 'SHELL',
    pattern: /\bdocker\s+(rm|system\s+prune|volume\s+rm)\b/,
    description: '删除 Docker 容器/卷',
    verdict: 'WARN',
  },

  // --- SQL ---
  {
    category: 'SQL',
    pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
    description: '删除表/数据库',
    verdict: 'STOP',
  },
  {
    category: 'SQL',
    pattern: /\bTRUNCATE\s+(TABLE\s+)?/i,
    description: '清空表数据（不可回滚）',
    verdict: 'STOP',
  },
  {
    category: 'SQL',
    pattern: /\bDELETE\s+FROM\b(?!.*\bWHERE\b)/i,
    description: '无条件 DELETE（将删除所有行）',
    verdict: 'STOP',
  },
  {
    category: 'SQL',
    pattern: /\bALTER\s+TABLE\b.*\bDROP\b/i,
    description: 'ALTER TABLE DROP（删除列/约束）',
    verdict: 'ASK',
  },
  {
    category: 'SQL',
    pattern: /\bUPDATE\b(?!.*\bWHERE\b)/i,
    description: '无条件 UPDATE（将更新所有行）',
    verdict: 'ASK',
  },

  // --- GIT ---
  {
    category: 'GIT',
    pattern: /\bpush\s+(--force|-f)\b/,
    description: '强制推送（覆盖远程历史）',
    verdict: 'STOP',
  },
  {
    category: 'GIT',
    pattern: /\bpush\s+.*--delete\b/,
    description: '删除远程分支',
    verdict: 'ASK',
  },
  {
    category: 'GIT',
    pattern: /\breset\s+--hard\b/,
    description: '硬重置（丢弃所有未提交更改）',
    verdict: 'ASK',
  },
  {
    category: 'GIT',
    pattern: /\bclean\s+-[fdx]+/,
    description: '清理未跟踪文件',
    verdict: 'WARN',
  },
  {
    category: 'GIT',
    pattern: /\brebase\s+(-i|--interactive)/,
    description: '交互式 rebase',
    verdict: 'WARN',
  },

  // --- FILE ---
  {
    category: 'FILE',
    pattern: undefined!,  // 特殊处理：不是正则，而是运行时检查
    description: '单次操作删除超过 5 个文件',
    verdict: 'ASK',
  },
  {
    category: 'FILE',
    pattern: undefined!,
    description: '修改超过 200 行代码的单次补丁',
    verdict: 'WARN',
  },

  // --- ENV ---
  {
    category: 'ENV',
    pattern: /(~\/\.bashrc|~\/\.zshrc|~\/\.profile|\/etc\/profile)/,
    description: '修改 shell 配置文件',
    verdict: 'ASK',
  },
  {
    category: 'ENV',
    pattern: /\/etc\/hosts/,
    description: '修改 hosts 文件',
    verdict: 'ASK',
  },
  {
    category: 'ENV',
    pattern: /\/etc\/(nginx|apache2|mysql|postgresql)/,
    description: '修改服务器配置',
    verdict: 'WARN',
  },
  {
    category: 'ENV',
    pattern: /export\s+(\w+)=/,
    description: '设置环境变量（仅在 shell 会话内生效）',
    verdict: 'ALLOW',
  },
];

// ============================================================================
// FILE 类特殊检查（非正则模式）
// ============================================================================

export function checkFileBulkDelete(fileCount: number): DangerPattern | null {
  if (fileCount > 5) {
    return {
      category: 'FILE',
      pattern: /.*/,
      description: `单次操作删除 ${fileCount} 个文件（超过 5 个上限）`,
      verdict: 'ASK',
    };
  }
  return null;
}

export function checkFileLargePatch(lineCount: number): DangerPattern | null {
  if (lineCount > 200) {
    return {
      category: 'FILE',
      pattern: /.*/,
      description: `单次补丁修改 ${lineCount} 行（超过 200 行上限）`,
      verdict: 'WARN',
    };
  }
  return null;
}
