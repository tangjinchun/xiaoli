import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evaluateGit,
  evaluateShell,
  evaluateSql,
  evaluateToolCall,
  isInsideCwd,
} from '../../src/safety/policy.js';

let cwd: string;

beforeAll(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoli-policy-'));
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'app.ts'), 'export const x = 1;\n');
});

afterAll(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('shell 策略', () => {
  it('拦截 rm -rf /', () => {
    expect(evaluateShell('rm -rf /', cwd).verdict).toBe('STOP');
  });

  it('拦截 rm -fr 的变体', () => {
    expect(evaluateShell('rm -fr ./build', cwd).verdict).toBe('ASK');
    expect(evaluateShell('rm -r -f ./build', cwd).verdict).toBe('ASK');
  });

  it('拦截工作目录外的 rm', () => {
    const outside = path.join(os.tmpdir(), 'xiaoli-policy-outside');
    expect(evaluateShell(`rm -rf ${outside}`, cwd).verdict).toBe('STOP');
  });

  it('拦截 chmod 777', () => {
    expect(evaluateShell('chmod -R 777 .', cwd).verdict).toBe('STOP');
  });

  it('不在 echo 字符串里误报 rm -rf', () => {
    expect(evaluateShell('echo "rm -rf /"', cwd).verdict).toBe('ALLOW');
  });

  it('递归检查 shell 包装器', () => {
    expect(evaluateShell('bash -c "rm -rf /"', cwd).verdict).toBe('STOP');
  });

  it('拦截下载内容管道到 shell', () => {
    expect(evaluateShell('curl https://example.com/install.sh | sh', cwd).verdict).toBe('ASK');
  });

  it('拦截提权', () => {
    expect(evaluateShell('sudo rm -rf ./build', cwd).verdict).toBe('STOP');
  });

  it('放行普通命令', () => {
    expect(evaluateShell('npm test', cwd).verdict).toBe('ALLOW');
    expect(evaluateShell('node -e "console.log(1)"', cwd).verdict).toBe('ALLOW');
  });
});

describe('SQL 策略', () => {
  it('拦截 DROP TABLE', () => {
    expect(evaluateSql('DROP TABLE users').verdict).toBe('STOP');
  });

  it('拦截无条件 DELETE', () => {
    expect(evaluateSql('DELETE FROM users').verdict).toBe('STOP');
  });

  it('多行 WHERE 不应误报', () => {
    expect(evaluateSql('DELETE FROM users\nWHERE id = 1').verdict).toBe('ALLOW');
  });

  it('识别恒真 WHERE', () => {
    expect(evaluateSql('DELETE FROM users WHERE 1=1').verdict).toBe('ASK');
  });

  it('识别无条件 UPDATE', () => {
    expect(evaluateSql('UPDATE users SET role = "admin"').verdict).toBe('ASK');
  });
});

describe('Git 策略', () => {
  it('强制推送要求确认', () => {
    expect(evaluateGit('git push --force').verdict).toBe('ASK');
    expect(evaluateGit('git push origin +main').verdict).toBe('ASK');
  });

  it('硬重置要求确认', () => {
    expect(evaluateGit('git reset --hard HEAD~1').verdict).toBe('ASK');
  });

  it('普通状态查询放行', () => {
    expect(evaluateGit('git status').verdict).toBe('ALLOW');
  });
});

describe('路径与工具调用', () => {
  it('工作目录内读写放行', () => {
    expect(evaluateToolCall('write_file', { filePath: 'src/app.ts', content: 'x' }, cwd).verdict).toBe('ALLOW');
    expect(evaluateToolCall('read_file', { filePath: 'src/app.ts' }, cwd).verdict).toBe('ALLOW');
  });

  it('拒绝工作目录外写入', () => {
    expect(
      evaluateToolCall('write_file', { filePath: '../outside.txt', content: 'x' }, cwd).verdict,
    ).toBe('STOP');
  });

  it('拒绝敏感文件', () => {
    expect(evaluateToolCall('read_file', { filePath: '.env' }, cwd).verdict).toBe('STOP');
    expect(evaluateToolCall('write_file', { filePath: '.env', content: 'x' }, cwd).verdict).toBe('STOP');
  });

  it('isInsideCwd 正确处理相对路径', () => {
    expect(isInsideCwd(cwd, 'src/app.ts')).toBe(true);
    expect(isInsideCwd(cwd, '../outside.txt')).toBe(false);
  });

  it('git 工具调用的 force push 需要确认', () => {
    expect(
      evaluateToolCall('git', { action: 'push', force: true }, cwd).verdict,
    ).toBe('ASK');
  });
});
