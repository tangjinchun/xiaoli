/**
 * 统一安全策略。
 *
 * 设计目标：
 *   1. 先解析命令/参数，再做判定，避免对整串文本做正则导致的误报和绕过。
 *   2. 所有工具调用走同一个入口，返回 ALLOW / WARN / ASK / STOP。
 *   3. 路径默认限制在任务工作目录内，敏感文件直接拒绝。
 *
 * 这不是 OS 级沙箱，而是 xiaoli 的“计划内自动执行、计划外高危拦截”策略层。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolName } from '../engine/types.js';

export type PolicyVerdict = 'ALLOW' | 'WARN' | 'ASK' | 'STOP';

export interface PolicyMatch {
  rule: string;
  description: string;
  verdict: PolicyVerdict;
}

export interface PolicyResult {
  verdict: PolicyVerdict;
  matches: PolicyMatch[];
  reason: string;
  commandName?: string;
}

export interface ParsedCommand {
  tokens: string[];
  hasShellMeta: boolean;
  original: string;
}

const VERDICT_PRIORITY: Record<PolicyVerdict, number> = {
  STOP: 0,
  ASK: 1,
  WARN: 2,
  ALLOW: 3,
};

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh']);
const SQL_CLIENTS = new Set(['mysql', 'mariadb', 'psql', 'sqlite3']);

function match(rule: string, description: string, verdict: PolicyVerdict): PolicyMatch {
  return { rule, description, verdict };
}

function worstVerdict(matches: PolicyMatch[]): PolicyVerdict {
  let worst: PolicyVerdict = 'ALLOW';
  for (const m of matches) {
    if (VERDICT_PRIORITY[m.verdict] < VERDICT_PRIORITY[worst]) {
      worst = m.verdict;
    }
  }
  return worst;
}

function result(matches: PolicyMatch[], commandName?: string): PolicyResult {
  if (matches.length === 0) {
    return {
      verdict: 'ALLOW',
      matches: [],
      reason: '未匹配任何危险模式',
      commandName,
    };
  }
  const verdict = worstVerdict(matches);
  return {
    verdict,
    matches,
    reason: matches.map((m) => `· ${m.description} (${m.verdict})`).join('\n'),
    commandName,
  };
}

// ============================================================================
// 命令解析
// ============================================================================

function stripCommonRedirections(command: string): string {
  return command
    .replace(/\d*>&\d*/g, ' ')
    .replace(/&>\s*\/dev\/null/g, ' ')
    .replace(/>\s*\/dev\/null/g, ' ')
    .replace(/2>\s*\/dev\/null/g, ' ');
}

/**
 * 轻量 shell tokenizer：支持引号、转义，并记录是否包含管道/重定向/命令串联。
 * 它不执行 shell，只用于策略判定。
 */
export function tokenize(command: string): ParsedCommand {
  const original = command;
  const source = stripCommonRedirections(command);
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let hasShellMeta = false;

  const pushCurrent = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\' && quote !== "'") {
      const next = source[i + 1];
      const windowsPathSeparator =
        process.platform === 'win32' &&
        next !== undefined &&
        !['"', "'", '\\', ' ', '\t', '|', '&', ';', '>', '<'].includes(next);
      if (windowsPathSeparator) {
        current += ch;
      } else {
        escaped = true;
      }
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === '`') {
      hasShellMeta = true;
      current += ch;
      continue;
    }

    if (ch === '$' && source[i + 1] === '(') {
      hasShellMeta = true;
      current += ch;
      continue;
    }

    // $VAR / ${VAR} 会在执行时展开，路径检查无法静态确认；保守地要求确认。
    if (ch === '$' && /[A-Za-z_{]/.test(source[i + 1] ?? '')) {
      hasShellMeta = true;
      current += ch;
      continue;
    }

    if (ch === ';' || ch === '|' || ch === '&' || ch === '>' || ch === '<' || ch === '\n') {
      hasShellMeta = true;
      pushCurrent();
      tokens.push(ch);
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    current += ch;
  }

  pushCurrent();

  return { tokens, hasShellMeta, original };
}

function splitSegments(tokens: string[]): string[][] {
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (token === '|' || token === ';' || token === '&' || token === '&&' || token === '||') {
      if (segments[segments.length - 1].length > 0) {
        segments.push([]);
      }
      continue;
    }
    segments[segments.length - 1].push(token);
  }
  return segments.filter((s) => s.length > 0);
}

function isOption(token: string): boolean {
  return token.startsWith('-') && token !== '-';
}

function optionChars(args: string[]): Set<string> {
  const chars = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith('-') || arg === '--') continue;
    if (arg.startsWith('--')) {
      chars.add(arg.slice(2));
      continue;
    }
    for (const ch of arg.slice(1)) chars.add(ch);
  }
  return chars;
}

// ============================================================================
// 路径检查
// ============================================================================

function realish(p: string): string {
  const absolute = path.resolve(p);
  try {
    return fs.realpathSync(absolute);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export function isInsideCwd(cwd: string, target: string): boolean {
  if (!target || target === '-' || target === '/dev/null') return true;
  if (target === '~' || target.startsWith('~/')) return false;

  const root = realish(cwd);
  const resolved = realish(path.isAbsolute(target) ? target : path.join(cwd, target));
  return resolved === root || resolved.startsWith(root + path.sep);
}

const SENSITIVE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'authorized_keys',
  'known_hosts',
  'credentials',
  'secrets',
]);

const SENSITIVE_DIRS = ['.ssh', '.aws', '.kube', '.gnupg', '.xiaoli'];

export function isSensitivePath(target: string): boolean {
  const normalized = target.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((p) => SENSITIVE_DIRS.includes(p))) return true;

  const base = parts[parts.length - 1] ?? '';
  // 模板文件不含真实密钥，允许读写。
  if (['.env.example', '.env.sample', '.env.template'].includes(base)) return false;
  if (SENSITIVE_NAMES.has(base)) return true;
  if (base.startsWith('.env.')) return true;
  if (base.endsWith('.pem') || base.endsWith('.key') || base.endsWith('.p12')) return true;
  if (base === '.git' || normalized.includes('/.git/config')) return true;
  return false;
}

export function checkPath(
  cwd: string,
  target: string,
  mode: 'read' | 'write',
): PolicyResult {
  if (!target || typeof target !== 'string') {
    return result([match('path.missing', '路径为空', 'STOP')]);
  }

  if (isSensitivePath(target)) {
    return result([match('path.sensitive', `拒绝访问敏感文件: ${target}`, 'STOP')]);
  }

  if (!isInsideCwd(cwd, target)) {
    return result([
      match(
        'path.outside',
        `拒绝访问工作目录之外的路径（${mode}）: ${target}`,
        'STOP',
      ),
    ]);
  }

  return result([]);
}

// ============================================================================
// SQL
// ============================================================================

export function evaluateSql(sql: string): PolicyResult {
  const matches: PolicyMatch[] = [];
  const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();

  if (/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/.test(normalized)) {
    matches.push(match('sql.drop', '删除表/数据库/模式', 'STOP'));
  }
  if (/\bTRUNCATE\b/.test(normalized)) {
    matches.push(match('sql.truncate', '清空表数据（不可回滚）', 'STOP'));
  }
  if (/\bDROP\s+INDEX\b/.test(normalized)) {
    matches.push(match('sql.drop-index', '删除索引', 'ASK'));
  }
  if (/\bDELETE\s+FROM\b/.test(normalized)) {
    if (!/\bWHERE\b/.test(normalized)) {
      matches.push(match('sql.delete-all', '无条件 DELETE（将删除所有行）', 'STOP'));
    } else if (/\bWHERE\s+1\s*=\s*1\b/.test(normalized)) {
      matches.push(match('sql.delete-tautology', 'DELETE 的 WHERE 恒为真', 'ASK'));
    }
  }
  if (/\bUPDATE\b/.test(normalized)) {
    if (!/\bWHERE\b/.test(normalized)) {
      matches.push(match('sql.update-all', '无条件 UPDATE（将更新所有行）', 'ASK'));
    } else if (/\bWHERE\s+1\s*=\s*1\b/.test(normalized)) {
      matches.push(match('sql.update-tautology', 'UPDATE 的 WHERE 恒为真', 'ASK'));
    }
  }
  if (/\bALTER\s+TABLE\b[\s\S]*\bDROP\b/.test(normalized)) {
    matches.push(match('sql.alter-drop', 'ALTER TABLE DROP（删除列/约束）', 'ASK'));
  }
  if (/\bGRANT\b|\bREVOKE\b/.test(normalized)) {
    matches.push(match('sql.grant', '修改数据库权限', 'ASK'));
  }

  return result(matches);
}

// ============================================================================
// Git
// ============================================================================

export function evaluateGit(command: string): PolicyResult {
  const parsed = tokenize(command);
  const gitIndex = parsed.tokens.findIndex((t) => path.basename(t) === 'git');
  if (gitIndex < 0) return result([]);

  const args = parsed.tokens.slice(gitIndex + 1).filter((t) => t !== '|' && t !== ';' && t !== '&');
  const sub = args.find((a) => !isOption(a));
  if (!sub) return result([]);

  const rest = args.slice(args.indexOf(sub) + 1);
  const matches: PolicyMatch[] = [];

  if (sub === 'push') {
    const force =
      rest.includes('--force') ||
      rest.includes('-f') ||
      rest.includes('--force-with-lease') ||
      rest.some((a) => a.startsWith('+'));
    if (force) {
      matches.push(match('git.push-force', '强制推送（覆盖远程历史）', 'ASK'));
    }
    if (rest.includes('--delete')) {
      matches.push(match('git.push-delete', '删除远程分支', 'ASK'));
    }
  }

  if (sub === 'reset' && rest.includes('--hard')) {
    matches.push(match('git.reset-hard', '硬重置（丢弃未提交更改）', 'ASK'));
  }

  if (sub === 'clean') {
    const flags = optionChars(rest);
    if (flags.has('f') || flags.has('x') || flags.has('d')) {
      matches.push(match('git.clean', '清理未跟踪文件', 'ASK'));
    }
  }

  if (sub === 'branch' && (rest.includes('-D') || rest.includes('--delete'))) {
    matches.push(match('git.branch-delete', '删除分支', 'ASK'));
  }

  if (sub === 'checkout' && rest.includes('.')) {
    matches.push(match('git.checkout-dot', '丢弃工作区改动', 'WARN'));
  }
  if (sub === 'restore' && rest.includes('.')) {
    matches.push(match('git.restore-dot', '恢复/丢弃工作区改动', 'WARN'));
  }

  if (sub === 'config' || sub === 'remote') {
    matches.push(match('git.config', '修改 Git 配置/远程地址', 'ASK'));
  }

  if (sub === 'filter-branch' || sub === 'filter-repo') {
    matches.push(match('git.history-rewrite', '重写 Git 历史', 'STOP'));
  }

  return result(matches);
}

// ============================================================================
// Shell
// ============================================================================

function evaluateSegment(
  segment: string[],
  cwd: string,
  depth: number,
): { matches: PolicyMatch[]; commandName?: string } {
  const matches: PolicyMatch[] = [];
  if (segment.length === 0) return { matches };

  let tokens = [...segment];

  // 去掉常见的前缀包装。
  while (tokens.length > 0 && ['env', 'command', 'nohup', 'time'].includes(tokens[0])) {
    tokens = tokens.slice(1);
    while (tokens.length > 0 && isOption(tokens[0])) tokens = tokens.slice(1);
  }

  if (tokens.length === 0) return { matches };

  const command = path.basename(tokens[0]).toLowerCase();
  const args = tokens.slice(1);

  if (command === 'sudo' || command === 'su' || command === 'doas') {
    matches.push(match('shell.privilege', '提权/切换 root', 'STOP'));
    return { matches, commandName: command };
  }

  if (command === 'rm') {
    const flags = optionChars(args);
    const targets = args.filter((a) => !isOption(a));
    const recursive = flags.has('r') || flags.has('R') || flags.has('recursive');
    const force = flags.has('f') || flags.has('force');

    if (targets.length === 0) {
      matches.push(match('shell.rm-no-target', 'rm 没有明确目标', 'ASK'));
    }

    for (const target of targets) {
      if (target === '/' || target === '~' || target === '..' || target === '.') {
        matches.push(match('shell.rm-critical', `rm 目标为危险路径: ${target}`, 'STOP'));
      } else if (!isInsideCwd(cwd, target)) {
        matches.push(match('shell.rm-outside', `rm 目标在工作目录之外: ${target}`, 'STOP'));
      } else if (target.includes('*')) {
        matches.push(match('shell.rm-glob', `rm 使用通配符: ${target}`, 'ASK'));
      }
    }

    if (recursive && force) {
      matches.push(match('shell.rm-rf', '递归强制删除', 'ASK'));
    } else if (recursive) {
      matches.push(match('shell.rm-recursive', '递归删除', 'ASK'));
    } else if (force) {
      matches.push(match('shell.rm-force', '强制删除', 'WARN'));
    }
  }

  if (command === 'chmod') {
    const flags = optionChars(args);
    const nonOptions = args.filter((a) => !isOption(a));
    const mode = nonOptions[0] ?? '';
    const targets = nonOptions.slice(1);
    if (mode.includes('777') || mode.includes('a+rwx')) {
      matches.push(match('shell.chmod-777', '将权限设为 777（所有人可读写执行）', 'STOP'));
    }
    if (flags.has('R') || flags.has('recursive')) {
      matches.push(match('shell.chmod-recursive', '递归修改权限', 'ASK'));
    }
    for (const target of targets) {
      if (!isInsideCwd(cwd, target)) {
        matches.push(match('shell.chmod-outside', `chmod 目标在工作目录之外: ${target}`, 'ASK'));
      }
    }
  }

  if (['dd', 'mkfs', 'mkfs.ext4', 'fdisk', 'parted', 'shutdown', 'reboot', 'halt', 'poweroff', 'format', 'diskpart'].includes(command)) {
    matches.push(match(`shell.${command}`, `系统级危险命令: ${command}`, 'STOP'));
  }

  if (command === 'find' && (args.includes('-delete') || args.includes('-exec'))) {
    matches.push(match('shell.find-delete', 'find 删除/执行命令', 'ASK'));
  }

  if (command === 'kill' && (args.includes('-9') || args.includes('-KILL'))) {
    matches.push(match('shell.kill-9', '强制终止进程', 'ASK'));
  }

  if (command === 'crontab') {
    matches.push(match('shell.crontab', '修改定时任务', 'ASK'));
  }

  if (command === 'docker' && ['rm', 'rmi', 'prune'].some((a) => args.includes(a))) {
    matches.push(match('shell.docker-destructive', '删除 Docker 容器/镜像/卷', 'ASK'));
  }

  if (command === 'npm' || command === 'pnpm' || command === 'yarn') {
    if (args.includes('publish')) {
      matches.push(match('shell.npm-publish', '发布 npm 包', 'ASK'));
    }
    const global = args.includes('-g') || args.includes('--global');
    if (global && (args.includes('install') || args.includes('add') || args.includes('i'))) {
      matches.push(match('shell.npm-global-install', '全局安装依赖', 'ASK'));
    }
  }

  if (command === 'systemctl' && ['stop', 'restart', 'disable', 'mask'].some((a) => args.includes(a))) {
    matches.push(match('shell.systemctl', '停止/重启/禁用系统服务', 'ASK'));
  }

  if (SHELLS.has(command)) {
    const scriptIndex = args.findIndex((a) => a === '-c' || a === '--command');
    if (scriptIndex >= 0 && args[scriptIndex + 1] && depth < 3) {
      const nested = evaluateShell(args[scriptIndex + 1], cwd, depth + 1);
      matches.push(...nested.matches);
    }
  }

  if (command === 'cmd' && args.some((a) => a === '/c' || a === '/C')) {
    const script = args[args.findIndex((a) => a.toLowerCase() === '/c') + 1];
    if (script && depth < 3) {
      const nested = evaluateShell(script, cwd, depth + 1);
      matches.push(...nested.matches);
    }
  }

  if (command === 'powershell' || command === 'pwsh') {
    const scriptIndex = args.findIndex((a) => ['-command', '-c'].includes(a.toLowerCase()));
    if (scriptIndex >= 0 && args[scriptIndex + 1] && depth < 3) {
      const nested = evaluateShell(args[scriptIndex + 1], cwd, depth + 1);
      matches.push(...nested.matches);
    }
  }

  if (SQL_CLIENTS.has(command)) {
    const executeIndex = args.findIndex((a) => a === '-e' || a === '--execute' || a === '-c' || a === '--command');
    const sql = executeIndex >= 0 ? args[executeIndex + 1] : '';
    if (sql) matches.push(...evaluateSql(sql).matches);
  }

  // 重定向到敏感路径 / 设备
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '>' && tokens[i + 1]) {
      const target = tokens[i + 1];
      if (target.startsWith('/dev/sd') || target.startsWith('/dev/nvme')) {
        matches.push(match('shell.disk-write', `直接写入磁盘设备: ${target}`, 'STOP'));
      } else if (isSensitivePath(target) || !isInsideCwd(cwd, target)) {
        matches.push(match('shell.redirect', `重定向到敏感/外部路径: ${target}`, 'ASK'));
      }
    }
  }

  return { matches, commandName: command };
}

export function evaluateShell(command: string, cwd = process.cwd(), depth = 0): PolicyResult {
  const parsed = tokenize(command);
  const matches: PolicyMatch[] = [];

  // fork bomb / 明显的命令替换
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command)) {
    matches.push(match('shell.fork-bomb', 'Fork bomb', 'STOP'));
  }

  const segments = splitSegments(parsed.tokens);
  for (const segment of segments) {
    const evaluated = evaluateSegment(segment, cwd, depth);
    matches.push(...evaluated.matches);
  }

  // 管道到 shell / 解释器
  if (parsed.hasShellMeta && parsed.tokens.includes('|')) {
    const hasDownload = segments.some((s) => ['curl', 'wget'].includes(path.basename(s[0] ?? '').toLowerCase()));
    const hasInterpreter = segments.some((s) => {
      const name = path.basename(s[0] ?? '').toLowerCase();
      return SHELLS.has(name) || ['python', 'python3', 'node', 'perl', 'ruby'].includes(name);
    });
    if (hasDownload && hasInterpreter) {
      matches.push(match('shell.pipe-to-shell', '下载内容直接管道到解释器执行', 'ASK'));
    }
  }

  // 命令串联/重定向本身不是危险，但需要用户知道 AI 在执行复合命令。
  if (parsed.hasShellMeta && matches.length === 0) {
    matches.push(match('shell.meta', '命令包含管道/重定向/串联', 'ASK'));
  }

  const commandName = segments[0] && segments[0][0] ? path.basename(segments[0][0]) : undefined;
  return result(matches, commandName);
}

// ============================================================================
// 工具调用
// ============================================================================

export function evaluateToolCall(
  tool: ToolName,
  input: Record<string, unknown>,
  cwd: string,
): PolicyResult {
  switch (tool) {
    case 'read_file': {
      const target = String(input.filePath ?? input.path ?? '');
      return checkPath(cwd, target, 'read');
    }
    case 'write_file':
    case 'patch_file': {
      const target = String(input.filePath ?? input.path ?? '');
      return checkPath(cwd, target, 'write');
    }
    case 'terminal': {
      const command = String(input.command ?? input.cmd ?? '');
      if (!command.trim()) {
        return result([match('shell.empty', '命令为空', 'STOP')]);
      }
      return evaluateShell(command, cwd);
    }
    case 'git': {
      const action = String(input.action ?? '');
      let command = `git ${action}`;
      if (action === 'push' && input.force === true) command += ' --force';
      if (action === 'push' && input.delete === true) command += ' --delete';
      if (action === 'reset' && input.hard === true) command += ' --hard';
      if (action === 'clean' && input.force === true) command += ' -fdx';
      if (action === 'branch' && input.delete === true) command += ' -D';
      if (action === 'commit' && typeof input.message === 'string') {
        command += ` -m ${JSON.stringify(input.message)}`;
      }
      return evaluateGit(command);
    }
    case 'ask_user':
      return result([]);
    case 'database':
      return result([match('tool.database', '数据库工具尚未实现', 'ASK')]);
    default:
      return result([match('tool.unknown', `未知工具: ${String(tool)}`, 'STOP')]);
  }
}

// ============================================================================
// 展示
// ============================================================================

export function formatPolicyReason(policy: PolicyResult): string {
  if (policy.matches.length === 0) return '安全';
  return policy.matches.map((m) => `${m.description} (${m.verdict})`).join('\n');
}

export function homeDir(): string {
  return os.homedir();
}
