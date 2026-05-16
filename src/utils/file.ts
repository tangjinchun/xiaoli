/**
 * 文件操作封装
 *
 * 职责：
 *   · 读文件（分块处理大文件）
 *   · 写文件（原子写入 + 备份）
 *   · 删除文件（批量安全检查）
 *   · patch 文件（行计数 + 安全扫描）
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanFile } from '../safety/scanner';
import { logSuccess, logFailure } from '../safety/audit';

// ============================================================================
// 类型
// ============================================================================

export interface ReadFileResult {
  content: string;
  lines: number;
  filePath: string;
}

export interface WriteFileResult {
  filePath: string;
  bytesWritten: number;
  backedUp: boolean;
}

export interface PatchResult {
  filePath: string;
  linesChanged: number;
  reverted: boolean;
}

// ============================================================================
// 读文件
// ============================================================================

export function readFile(
  filePath: string,
  maxLines?: number,
): ReadFileResult {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`文件不存在: ${absPath}`);
  }

  const raw = fs.readFileSync(absPath, 'utf-8');
  const lines = raw.split('\n');

  let content: string;
  if (maxLines && lines.length > maxLines) {
    content = lines.slice(0, maxLines).join('\n');
  } else {
    content = raw;
  }

  return { content, lines: Math.min(lines.length, maxLines ?? lines.length), filePath: absPath };
}

/**
 * 批量读文件（给定 glob 匹配的路径列表）
 */
export function readFiles(filePaths: string[]): Map<string, ReadFileResult> {
  const results = new Map<string, ReadFileResult>();
  for (const fp of filePaths) {
    try {
      results.set(fp, readFile(fp));
    } catch {
      // 跳过不存在的文件
    }
  }
  return results;
}

// ============================================================================
// 写文件（原子写入）
// ============================================================================

export function writeFile(
  filePath: string,
  content: string,
  opts?: { backup?: boolean; taskId?: string; stepId?: string },
): WriteFileResult {
  const absPath = path.resolve(filePath);
  const doBackup = opts?.backup ?? true;

  // 1. 备份
  let backedUp = false;
  if (doBackup && fs.existsSync(absPath)) {
    const bakPath = absPath + '.xiaoli.bak';
    fs.copyFileSync(absPath, bakPath);
    backedUp = true;
  }

  // 2. 原子写入（先写临时文件，再 rename）
  const tmpPath = absPath + '.xiaoli.tmp';
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, absPath);

  const bytesWritten = Buffer.byteLength(content, 'utf-8');

  // 3. 审计
  logSuccess(opts?.taskId, opts?.stepId, 'file', `write: ${absPath}`, 0);

  return { filePath: absPath, bytesWritten, backedUp };
}

// ============================================================================
// Patch（精准替换）
// ============================================================================

export function patchFile(
  filePath: string,
  oldString: string,
  newString: string,
  opts?: { taskId?: string; stepId?: string },
): PatchResult {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`文件不存在: ${absPath}`);
  }

  const original = fs.readFileSync(absPath, 'utf-8');
  const linesChanged = oldString.split('\n').length;

  // 安全扫描：补丁行数
  const scanResult = scanFile('patch', linesChanged);
  if (scanResult.verdict === 'STOP') {
    logFailure(
      opts?.taskId,
      opts?.stepId,
      'file',
      `patch: ${absPath}`,
      -1,
      scanResult.reason,
    );
    throw new Error(`补丁被拦截: ${scanResult.reason}`);
  }

  // 替换
  if (!original.includes(oldString)) {
    throw new Error(`未找到目标文本: ${oldString.slice(0, 80)}...`);
  }

  const patched = original.replace(oldString, newString);

  // 备份
  const bakPath = absPath + '.xiaoli.bak';
  fs.copyFileSync(absPath, bakPath);

  // 写入
  fs.writeFileSync(absPath, patched, 'utf-8');

  logSuccess(opts?.taskId, opts?.stepId, 'file', `patch: ${absPath}`, 0);

  return { filePath: absPath, linesChanged, reverted: false };
}

// ============================================================================
// 删除文件
// ============================================================================

export function deleteFiles(
  filePaths: string[],
  opts?: { taskId?: string; stepId?: string },
): { deleted: string[]; blocked: string[] } {
  const scanResult = scanFile('delete', filePaths.length);
  if (scanResult.verdict === 'STOP') {
    logFailure(
      opts?.taskId,
      opts?.stepId,
      'file',
      `delete ${filePaths.length} files`,
      -1,
      scanResult.reason,
    );
    throw new Error(`批量删除被拦截: ${scanResult.reason}`);
  }

  const deleted: string[] = [];
  const blocked: string[] = [];

  for (const fp of filePaths) {
    const absPath = path.resolve(fp);
    try {
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
        deleted.push(fp);
      }
    } catch (err: any) {
      blocked.push(fp);
    }
  }

  logSuccess(
    opts?.taskId,
    opts?.stepId,
    'file',
    `deleted ${deleted.length} files`,
    0,
  );

  return { deleted, blocked };
}

// ============================================================================
// 目录操作
// ============================================================================

export function listFiles(
  dirPath: string,
  recursive = false,
  maxDepth = 3,
): string[] {
  const absPath = path.resolve(dirPath);
  if (!fs.existsSync(absPath)) return [];

  const results: string[] = [];

  function walk(current: string, depth: number) {
    if (depth > maxDepth) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(current, e.name);
      results.push(full);
      if (e.isDirectory() && recursive && depth < maxDepth) {
        walk(full, depth + 1);
      }
    }
  }

  walk(absPath, 1);
  return results;
}
