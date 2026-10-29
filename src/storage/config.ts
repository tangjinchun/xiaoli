/**
 * xiaoli 配置管理。
 *
 * 路径：~/.xiaoli/config.json（可用 XIAOLI_HOME 覆盖）
 * 环境变量覆盖：XIAOLI_API_KEY, XIAOLI_API_BASE_URL
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { XiaoliConfig } from '../engine/types.js';
import { getConfigPath, ensureXiaoliHome } from './paths.js';

export const DEFAULT_CONFIG: XiaoliConfig = {
  api: {
    provider: 'deepseek',
    key: '',
    baseUrl: 'https://api.deepseek.com',
    modelPro: 'deepseek-v4-pro',
    modelFlash: 'deepseek-flash',
  },
  safety: {
    requireDangerousConfirm: true,
    maxAutoRetry: 3,
    auditLogPath: '',
  },
  ui: {
    color: true,
    progressBars: true,
    compactMode: false,
  },
};

const ALLOWED_KEYS = new Set([
  'api.provider',
  'api.key',
  'api.baseUrl',
  'api.modelPro',
  'api.modelFlash',
  'safety.requireDangerousConfirm',
  'safety.maxAutoRetry',
  'safety.auditLogPath',
  'ui.color',
  'ui.progressBars',
  'ui.compactMode',
]);

function ensureConfigDir(): void {
  ensureXiaoliHome();
}

export function configFilePath(): string {
  return getConfigPath();
}

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function cloneDefault(): XiaoliConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as XiaoliConfig;
}

/**
 * 加载完整配置。环境变量优先级高于配置文件。
 */
export function loadConfig(): XiaoliConfig {
  ensureConfigDir();

  let fileConfig: Partial<XiaoliConfig> = {};
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Partial<XiaoliConfig>;
    } catch {
      console.warn('⚠ 配置文件损坏，使用默认配置');
    }
  }

  const config = cloneDefault();
  if (fileConfig.api) Object.assign(config.api, fileConfig.api);
  if (fileConfig.safety) Object.assign(config.safety, fileConfig.safety);
  if (fileConfig.ui) Object.assign(config.ui, fileConfig.ui);

  if (process.env.XIAOLI_API_KEY) {
    config.api.key = process.env.XIAOLI_API_KEY;
  }
  if (process.env.XIAOLI_API_BASE_URL) {
    config.api.baseUrl = process.env.XIAOLI_API_BASE_URL;
  }

  return config;
}

/**
 * 保存配置到文件。先写临时文件再 rename，避免半个 JSON。
 */
export function saveConfig(config: XiaoliConfig): void {
  ensureConfigDir();
  const target = getConfigPath();
  const tmp = path.join(path.dirname(target), `.config.${process.pid}.tmp`);
  const content = JSON.stringify(config, null, 2);

  fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, target);

  // Windows 上 chmod 基本无效；POSIX 上收紧权限。
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // 权限收紧失败不阻塞使用
    }
  }
}

export function hasApiKey(): boolean {
  return loadConfig().api.key.trim().length > 0;
}

/**
 * 获取 API key，未配置时抛出可执行的提示。
 */
export function getApiKey(): string {
  const config = loadConfig();
  if (!config.api.key) {
    throw new Error(
      '未配置 DeepSeek API key。请运行：\n' +
        '  xiaoli config set api.key sk-xxx\n' +
        '或设置环境变量：\n' +
        '  export XIAOLI_API_KEY=sk-xxx',
    );
  }
  return config.api.key;
}

/**
 * 获取 API 配置（key + baseUrl + 模型名）。
 */
export function getApiConfig(): {
  key: string;
  baseUrl: string;
  modelPro: string;
  modelFlash: string;
} {
  const config = loadConfig();
  return {
    key: getApiKey(),
    baseUrl: config.api.baseUrl,
    modelPro: config.api.modelPro,
    modelFlash: config.api.modelFlash,
  };
}

/**
 * 设置单个配置项（点号分隔路径，如 api.key）。
 */
export function setConfigValue(keyPath: string, rawValue: string): void {
  if (!ALLOWED_KEYS.has(keyPath)) {
    throw new Error(
      `未知配置项: ${keyPath}\n可用配置项:\n  ${Array.from(ALLOWED_KEYS).join('\n  ')}`,
    );
  }

  const config = loadConfig();
  const parts = keyPath.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] === undefined || current[parts[i]] === null) {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }

  const leaf = parts[parts.length - 1];
  const defaultValue = getDefaultByPath(keyPath);
  let value: unknown = rawValue;

  if (typeof defaultValue === 'boolean') {
    const normalized = rawValue.trim().toLowerCase();
    if (!['true', 'false', '1', '0', 'yes', 'no'].includes(normalized)) {
      throw new Error(`${keyPath} 需要布尔值（true/false）`);
    }
    value = ['true', '1', 'yes'].includes(normalized);
  } else if (typeof defaultValue === 'number') {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${keyPath} 需要数字`);
    }
    value = parsed;
  } else if (keyPath === 'api.key') {
    value = rawValue.trim();
  }

  current[leaf] = value;
  saveConfig(config);
}

function getDefaultByPath(keyPath: string): unknown {
  let current: unknown = DEFAULT_CONFIG;
  for (const part of keyPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * 获取配置项值。默认隐藏 API key。
 */
export function getConfigValue(keyPath: string, revealSecret = false): string | undefined {
  if (!ALLOWED_KEYS.has(keyPath)) {
    return undefined;
  }

  const config = loadConfig();
  let current: unknown = config;
  for (const part of keyPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  if (keyPath === 'api.key' && !revealSecret) {
    return maskSecret(String(current ?? ''));
  }
  return String(current);
}

/**
 * 列出所有配置（隐藏 API key）。
 */
export function listConfig(): Record<string, string> {
  const flat = flattenConfig(loadConfig() as unknown as Record<string, unknown>);
  flat['api.key'] = maskSecret(flat['api.key'] ?? '');
  return flat;
}

function flattenConfig(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(result, flattenConfig(value as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = String(value);
    }
  }
  return result;
}
