/**
 * xiaoli 数据目录解析。
 *
 * 默认是 ~/.xiaoli。测试和测评可以通过 XIAOLI_HOME 隔离，
 * 避免污染用户真实的配置、数据库和审计日志。
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

export function getXiaoliHome(): string {
  const override = process.env.XIAOLI_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.xiaoli');
}

export function getConfigPath(): string {
  return path.join(getXiaoliHome(), 'config.json');
}

export function getDbPath(): string {
  return path.join(getXiaoliHome(), 'data.db');
}

export function getAuditPath(): string {
  return path.join(getXiaoliHome(), 'audit.log');
}

export function ensureXiaoliHome(): string {
  const home = getXiaoliHome();
  fs.mkdirSync(home, { recursive: true });
  return home;
}
