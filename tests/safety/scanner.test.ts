import { describe, expect, it } from 'vitest';
import { scan, scanFile } from '../../src/safety/scanner.js';

describe('安全扫描兼容层', () => {
  it('shell STOP', () => {
    expect(scan({ command: 'rm -rf /', type: 'shell' }).verdict).toBe('STOP');
  });

  it('git status ALLOW', () => {
    expect(scan({ command: 'git status', type: 'git' }).verdict).toBe('ALLOW');
  });

  it('force push ASK', () => {
    expect(scan({ command: 'git push --force', type: 'git' }).verdict).toBe('ASK');
  });

  it('DROP TABLE STOP', () => {
    expect(scan({ command: 'DROP TABLE users', type: 'sql' }).verdict).toBe('STOP');
  });

  it('readonly ALLOW', () => {
    expect(scan({ command: 'cat README.md', type: 'readonly' }).verdict).toBe('ALLOW');
  });

  it('批量删除 ASK', () => {
    expect(scanFile('delete', 10).verdict).toBe('ASK');
  });

  it('大补丁 WARN', () => {
    expect(scanFile('patch', 250).verdict).toBe('WARN');
  });
});
