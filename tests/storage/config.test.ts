import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getConfigValue,
  hasApiKey,
  listConfig,
  loadConfig,
  setConfigValue,
} from '../../src/storage/config.js';

let home: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoli-config-'));
  process.env.XIAOLI_HOME = home;
  delete process.env.XIAOLI_API_KEY;
  delete process.env.XIAOLI_API_BASE_URL;
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('配置管理', () => {
  it('默认配置包含可用模型名', () => {
    const config = loadConfig();
    expect(config.api.modelPro).toBe('deepseek-v4-pro');
    expect(config.api.modelFlash).toBe('deepseek-flash');
    expect(config.safety.maxAutoRetry).toBe(3);
  });

  it('设置 API key 并脱敏读取', () => {
    setConfigValue('api.key', 'sk-test-12345678');
    expect(loadConfig().api.key).toBe('sk-test-12345678');
    expect(hasApiKey()).toBe(true);
    expect(getConfigValue('api.key')).toBe('sk-t****5678');
    expect(listConfig()['api.key']).toBe('sk-t****5678');
  });

  it('布尔和数字配置会被转换', () => {
    setConfigValue('ui.color', 'false');
    setConfigValue('safety.maxAutoRetry', '5');
    expect(loadConfig().ui.color).toBe(false);
    expect(loadConfig().safety.maxAutoRetry).toBe(5);
  });

  it('拒绝未知配置项', () => {
    expect(() => setConfigValue('api.unknown', 'x')).toThrow(/未知配置项/);
  });

  it('支持 api-key 别名', () => {
    expect(getConfigValue('api.key')).toBe('sk-t****5678');
  });
});
