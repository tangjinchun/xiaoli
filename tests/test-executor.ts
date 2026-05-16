/**
 * 执行器 + 安全扫描 验证
 *
 * 测试：
 *   1. 安全扫描器对危险命令的正确拦截
 *   2. 执行器对简单文件的读写
 */

import { scan } from '../src/safety/scanner';
import { shell } from '../src/utils/shell';
import { readFile, writeFile } from '../src/utils/file';
import { status as gitStatus } from '../src/utils/git';
import { detectEnv, isPortInUse } from '../src/utils/env';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

async function main() {
  console.log('\n=== 安全扫描器 ===\n');

  // 1. STOP 级拦截
  test('rm -rf 被 STOP', () => {
    const r = scan({ command: 'rm -rf /tmp/test', type: 'shell' });
    if (r.verdict !== 'STOP') throw new Error(`期望 STOP，实际 ${r.verdict}`);
    if (r.matches.length === 0) throw new Error('应该匹配危险模式');
  });

  test('DROP TABLE 被 STOP', () => {
    const r = scan({ command: 'DROP TABLE orders', type: 'sql' });
    if (r.verdict !== 'STOP') throw new Error(`期望 STOP，实际 ${r.verdict}`);
  });

  test('git push --force 被 STOP', () => {
    const r = scan({ command: 'git push --force origin main', type: 'git' });
    if (r.verdict !== 'STOP') throw new Error(`期望 STOP，实际 ${r.verdict}`);
  });

  test('chmod 777 被 STOP', () => {
    const r = scan({ command: 'sudo chmod 777 /var/www', type: 'shell' });
    if (r.verdict !== 'STOP') throw new Error(`期望 STOP，实际 ${r.verdict}`);
  });

  // 2. 安全放行
  test('git status 安全放行', () => {
    const r = scan({ command: 'git status', type: 'git' });
    if (r.verdict !== 'ALLOW') throw new Error(`期望 ALLOW，实际 ${r.verdict}`);
  });

  test('npm install 安全放行', () => {
    const r = scan({ command: 'npm install express', type: 'shell' });
    if (r.verdict !== 'ALLOW') throw new Error(`期望 ALLOW，实际 ${r.verdict}`);
  });

  test('只读操作直接放行', () => {
    const r = scan({ command: 'cat README.md', type: 'readonly' });
    if (r.verdict !== 'ALLOW') throw new Error(`期望 ALLOW，实际 ${r.verdict}`);
  });

  // 3. FILE 防删除
  test('删除 10 个文件触发 ASK', () => {
    const r = scan({
      command: 'delete-files',
      type: 'file',
      metadata: { deleteFileCount: 10 },
    });
    if (r.verdict !== 'ASK') throw new Error(`期望 ASK，实际 ${r.verdict}`);
  });

  test('补丁 >200 行触发 WARN', () => {
    const r = scan({
      command: 'patch',
      type: 'file',
      metadata: { patchLineCount: 250 },
    });
    if (r.verdict !== 'WARN') throw new Error(`期望 WARN，实际 ${r.verdict}`);
  });

  console.log('\n=== 文件操作 ===\n');

  // 创建测试文件
  const tmpDir = path.join(os.tmpdir(), 'xiaoli-test-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const testFile = path.join(tmpDir, 'test.txt');

  test('写文件', () => {
    const result = writeFile(testFile, 'hello xiaoli', { backup: false });
    if (!fs.existsSync(testFile)) throw new Error('文件未创建');
    if (result.bytesWritten !== 12) throw new Error(`期望 12 字节，实际 ${result.bytesWritten}`);
  });

  test('读文件', () => {
    const result = readFile(testFile);
    if (result.content !== 'hello xiaoli') throw new Error(`期望 'hello xiaoli'，实际 '${result.content}'`);
    if (result.lines !== 1) throw new Error(`期望 1 行，实际 ${result.lines}`);
  });

  test('写文件覆盖', () => {
    writeFile(testFile, 'updated content\nline 2\nline 3');
    const result = readFile(testFile);
    if (result.lines !== 3) throw new Error(`期望 3 行，实际 ${result.lines}`);
    if (!result.content.includes('line 2')) throw new Error('内容不匹配');
  });

  // 清理
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('\n=== Shell 执行 ===\n');

  test('echo 命令', () => {
    const result = shell('echo "test output"', { timeout: 5_000 });
    if (result.exitCode !== 0) throw new Error(`退出码 ${result.exitCode}`);
    if (!result.stdout.includes('test output')) throw new Error(`输出不匹配: ${result.stdout}`);
  });

  test('which node', () => {
    const result = shell('which node', { timeout: 5_000 });
    if (result.exitCode !== 0) throw new Error('node 未找到');
  });

  test('命令超时', () => {
    const result = shell('sleep 5', { timeout: 1_000 });
    if (!result.timedOut) throw new Error('应该超时但没超时');
  });

  console.log('\n=== Git ===\n');

  test('git status 在当前目录', () => {
    // xiaoli 项目可能未初始化 git，用进程 cwd 的 git 仓库
    const projDir = process.cwd();
    const hasGit = require('node:fs').existsSync(
      require('node:path').join(projDir, '.git'),
    );
    if (hasGit) {
      const s = gitStatus(projDir);
      if (!s.branch) throw new Error('分支为空');
      console.log(`     分支: ${s.branch}, 脏: ${s.dirty}`);
    } else {
      console.log('     (跳过 — 当前目录不是 Git 仓库)');
    }
  });

  console.log('\n=== 环境检测 ===\n');

  test('环境信息检测', () => {
    const info = detectEnv();
    if (!info.node) throw new Error('Node 版本为空');
    if (!info.os) throw new Error('OS 为空');
    console.log(`     OS: ${info.os}, Node: ${info.node}`);
  });

  test('端口检测（不存在的端口）', () => {
    const inUse = isPortInUse(59999);
    if (inUse) console.log('     (端口被占用，可能是巧合)');
    // 不判断，只是检测不崩
  });

  console.log('\n=== 执行器 ===\n');

  test('执行器模块可导入', async () => {
    const { execute } = await import('../src/engine/executor');
    if (typeof execute !== 'function') throw new Error('execute 不是函数');
  });

  console.log(`\n${'='.repeat(40)}`);
  console.log(`通过: ${passed} / ${passed + failed}`);
  if (failed > 0) {
    console.log(`失败: ${failed}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
