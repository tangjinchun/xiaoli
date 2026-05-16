/**
 * 环境检测与自愈
 *
 * 策略：
 *   JDK 版本问题    → 检测已安装版本，调整 JAVA_HOME
 *   Node 版本问题   → 检测 nvm 版本，建议切换
 *   npm/pip 冲突    → 尝试 --legacy-peer-deps / 降级
 *   数据库连接失败  → 检查配置文件，尝试备选端口
 *   端口占用        → netstat 检测 → 尝试 kill 旧进程
 */

import { shell, commandExists, type ShellResult } from './shell';

// ============================================================================
// 类型
// ============================================================================

export interface EnvInfo {
  os: string;
  shell: string;
  node: string;
  npm: string;
  java?: string;
  python?: string;
  git: string;
  docker?: string;
}

export interface SelfHealResult {
  healed: boolean;
  action: string;
  detail: string;
}

// ============================================================================
// 环境信息采集
// ============================================================================

export function detectEnv(): EnvInfo {
  const info: EnvInfo = {
    os: process.platform,
    shell: process.env.SHELL || 'unknown',
    node: process.version,
    npm: '',
    git: '',
  };

  try { info.npm = shell('npm --version', { timeout: 5_000 }).stdout; } catch { /* */ }
  try { info.git = shell('git --version', { timeout: 5_000 }).stdout; } catch { /* */ }
  try { info.java = shell('java -version 2>&1', { timeout: 5_000 }).stderr.split('\n')[0]; } catch { /* */ }
  try { info.python = shell('python3 --version', { timeout: 5_000 }).stdout; } catch { /* */ }
  try {
    const d = shell('docker --version', { timeout: 5_000 }).stdout;
    if (d) info.docker = d;
  } catch { /* */ }

  return info;
}

// ============================================================================
// 自愈策略
// ============================================================================

/** 检查端口是否被占用 */
export function isPortInUse(port: number): boolean {
  try {
    const out = shell(`lsof -i :${port} -t`, { timeout: 3_000 });
    return out.stdout.length > 0;
  } catch {
    try {
      const out = shell(`netstat -tlnp | grep :${port}`, { timeout: 3_000 });
      return out.stdout.length > 0;
    } catch {
      return false;
    }
  }
}

/** 释放端口 */
export function freePort(port: number): SelfHealResult {
  if (!isPortInUse(port)) {
    return { healed: false, action: 'free_port', detail: `端口 ${port} 未被占用` };
  }

  try {
    const pid = shell(`lsof -i :${port} -t`, { timeout: 3_000 }).stdout.trim();
    if (pid) {
      shell(`kill -9 ${pid}`, { timeout: 3_000 });
      return {
        healed: true,
        action: 'free_port',
        detail: `已终止进程 ${pid}，释放端口 ${port}`,
      };
    }
  } catch {
    // netstat 路径
  }

  return { healed: false, action: 'free_port', detail: `无法释放端口 ${port}` };
}

/** JDK 环境自愈：寻找可用的 Java 并设置 JAVA_HOME */
export function healJava(minVersion = 11): SelfHealResult {
  const javas = findJavaInstallations();
  if (javas.length === 0) {
    return { healed: false, action: 'heal_java', detail: '未找到任何 Java 安装' };
  }

  for (const j of javas) {
    try {
      const ver = shell(`"${j}/bin/java" -version 2>&1`, { timeout: 5_000 });
      const versionMatch = ver.stderr.match(/version "(\d+)/);
      if (versionMatch && parseInt(versionMatch[1], 10) >= minVersion) {
        process.env.JAVA_HOME = j;
        process.env.PATH = `${j}/bin:${process.env.PATH}`;
        return {
          healed: true,
          action: 'heal_java',
          detail: `已切换 JAVA_HOME 到 ${j} (版本 ${versionMatch[1]})`,
        };
      }
    } catch {
      continue;
    }
  }

  return {
    healed: false,
    action: 'heal_java',
    detail: `找到 ${javas.length} 个 Java 安装，但都不满足最低版本 ${minVersion}`,
  };
}

/** NPM 依赖冲突自愈 */
export function healNpm(projectDir: string): SelfHealResult {
  try {
    shell(`cd ${projectDir} && npm install --legacy-peer-deps`, { timeout: 60_000 });
    return { healed: true, action: 'heal_npm', detail: '已使用 --legacy-peer-deps 重新安装' };
  } catch (err: any) {
    // 尝试删除 node_modules 后重装
    try {
      shell(`cd ${projectDir} && rm -rf node_modules && npm install`, { timeout: 120_000 });
      return { healed: true, action: 'heal_npm', detail: '已删除 node_modules 并重新安装' };
    } catch {
      return { healed: false, action: 'heal_npm', detail: `无法修复 NPM 依赖: ${err.message}` };
    }
  }
}

/** 数据库连接自愈：检查端口配置，尝试备选 */
export function healDatabase(
  configPath: string,
  defaultPort: number,
): SelfHealResult {
  if (isPortInUse(defaultPort)) {
    return { healed: true, action: 'heal_db', detail: `数据库端口 ${defaultPort} 已监听` };
  }

  // 尝试常见备选端口
  const altPorts = [3306, 5432, 5433, 3307];
  for (const port of altPorts) {
    if (port === defaultPort) continue;
    if (isPortInUse(port)) {
      return {
        healed: true,
        action: 'heal_db',
        detail: `默认端口 ${defaultPort} 不可用，检测到备选端口 ${port} 正在监听`,
      };
    }
  }

  return { healed: false, action: 'heal_db', detail: `无法连接数据库，端口 ${defaultPort} 未监听` };
}

// ============================================================================
// 内部函数
// ============================================================================

function findJavaInstallations(): string[] {
  const candidates: string[] = [];

  // Linux
  try {
    const readlink = shell('readlink -f $(which java)', { timeout: 3_000 }).stdout;
    if (readlink) {
      const match = readlink.match(/(\/.*\/jdk[^\/]*)/);
      if (match) candidates.push(match[1]);
    }
  } catch { /* */ }

  // /usr/lib/jvm
  try {
    const ls = shell('ls -d /usr/lib/jvm/java-*-openjdk-* 2>/dev/null', { timeout: 3_000 }).stdout;
    candidates.push(...ls.split('\n').filter(Boolean));
  } catch { /* */ }

  // macOS
  try {
    const brew = shell('brew --prefix openjdk@17 2>/dev/null', { timeout: 3_000 }).stdout;
    if (brew) candidates.push(brew);
  } catch { /* */ }

  // JAVA_HOME 环境变量
  if (process.env.JAVA_HOME) candidates.unshift(process.env.JAVA_HOME);

  return [...new Set(candidates)];
}
