/**
 * xiaoli 配置文件管理
 *
 * 路径：~/.xiaoli/config.json
 * 环境变量覆盖：XIAOLI_API_KEY, XIAOLI_API_BASE_URL
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { XiaoliConfig } from '../engine/types.js';

/** xiaoli 配置目录 */
const CONFIG_DIR = path.join(os.homedir(), '.xiaoli');
/** 配置文件路径 */
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

/** 默认配置 */
const DEFAULT_CONFIG: XiaoliConfig = {
  api: {
    provider: 'deepseek',
    key: '',
    baseUrl: 'https://api.deepseek.com',
    modelPro: 'deepseek-v4-pro',
    modelFlash: 'deepseek-v4-flash',
  },
  safety: {
    requireDangerousConfirm: true,
    maxAutoRetry: 3,
    auditLogPath: '~/.xiaoli/audit.log',
  },
  ui: {
    color: true,
    progressBars: true,
    compactMode: false,
  },
};

/**
 * 确保配置目录存在
 */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * 加载完整配置。环境变量优先级高于配置文件。
 */
export function loadConfig(): XiaoliConfig {
  ensureConfigDir();

  let fileConfig: Partial<XiaoliConfig> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      fileConfig = JSON.parse(raw);
    } catch {
      // 配置文件损坏时使用默认值
      console.warn('⚠ 配置文件损坏，使用默认配置');
    }
  }

  // 深度合并，环境变量覆盖
  const config: XiaoliConfig = {
    api: {
      ...DEFAULT_CONFIG.api,
      ...fileConfig.api,
    },
    safety: {
      ...DEFAULT_CONFIG.safety,
      ...fileConfig.safety,
    },
    ui: {
      ...DEFAULT_CONFIG.ui,
      ...fileConfig.ui,
    },
  };

  // 环境变量覆盖
  if (process.env.XIAOLI_API_KEY) {
    config.api.key = process.env.XIAOLI_API_KEY;
  }
  if (process.env.XIAOLI_API_BASE_URL) {
    config.api.baseUrl = process.env.XIAOLI_API_BASE_URL;
  }

  return config;
}

/**
 * 保存配置到文件
 */
export function saveConfig(config: XiaoliConfig): void {
  ensureConfigDir();
  // 不将 API key 的星号掩码写回文件
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * 获取 API key
 */
export function getApiKey(): string {
  const config = loadConfig();
  if (!config.api.key) {
    throw new Error(
      '未配置 DeepSeek API key。请运行：\n' +
      '  xiaoli config set api.key sk-xxx\n' +
      '或设置环境变量：\n' +
      '  export XIAOLI_API_KEY=sk-xxx'
    );
  }
  return config.api.key;
}

/**
 * 获取 API 配置（key + baseUrl）
 */
export function getApiConfig(): { key: string; baseUrl: string; modelPro: string; modelFlash: string } {
  const config = loadConfig();
  return {
    key: getApiKey(),
    baseUrl: config.api.baseUrl,
    modelPro: config.api.modelPro,
    modelFlash: config.api.modelFlash,
  };
}

/**
 * 设置单个配置项（点号分隔路径，如 api.key）
 */
export function setConfigValue(keyPath: string, value: string): void {
  const config = loadConfig();
  const parts = keyPath.split('.');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]]) {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;

  saveConfig(config);
}

/**
 * 获取配置项值
 */
export function getConfigValue(keyPath: string): string | undefined {
  const config = loadConfig();
  const parts = keyPath.split('.');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = config;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = current[part];
  }

  return String(current);
}

/**
 * 列出所有配置（隐藏 API key）
 */
export function listConfig(): Record<string, string> {
  const config = loadConfig();
  const key = config.api.key;
  // 遮蔽 API key
  if (key && key.length > 8) {
    config.api.key = key.slice(0, 4) + '****' + key.slice(-4);
  }

  return flattenConfig(config as unknown as Record<string, unknown>);
}

/** 将嵌套配置展平为 key=value 对 */
function flattenConfig(
  obj: Record<string, unknown>,
  prefix = ''
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(
        result,
        flattenConfig(value as Record<string, unknown>, fullKey)
      );
    } else {
      result[fullKey] = String(value);
    }
  }
  return result;
}
