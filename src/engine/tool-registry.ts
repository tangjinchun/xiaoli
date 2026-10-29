/**
 * 工具注册表。
 *
 * 每个工具都有：
 *   - 给模型看的 JSON schema
 *   - 参数校验
 *   - 执行器
 *
 * 执行器只通过这里调用外部世界，不再 switch 一堆未定义的字段。
 */

import * as path from 'node:path';
import type { RiskLevel, ToolName } from './types.js';
import { readFile, writeFile, patchFile } from '../utils/file.js';
import { runCommand } from '../utils/shell.js';
import * as gitUtils from '../utils/git.js';
import {
  TaskPausedError,
  ToolExecutionError,
} from './errors.js';

export interface ToolContext {
  taskId: string;
  stepId: string;
  cwd: string;
  signal?: AbortSignal;
  confirmed?: boolean;
  askUser?: (prompt: string) => Promise<string | null>;
}

export interface ToolResult {
  output: string;
  data?: unknown;
}

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  defaultRisk: RiskLevel;
  validate(input: Record<string, unknown>): string[];
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

function requireString(
  input: Record<string, unknown>,
  key: string,
  issues: string[],
): string {
  const value = input[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push(`${key} 必须是非空字符串`);
    return '';
  }
  return value;
}

function optionalNumber(
  input: Record<string, unknown>,
  key: string,
  issues: string[],
): number | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    issues.push(`${key} 必须是正数`);
    return undefined;
  }
  return value;
}

function optionalStringArray(
  input: Record<string, unknown>,
  key: string,
  issues: string[],
): string[] | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    issues.push(`${key} 必须是字符串数组`);
    return undefined;
  }
  return value as string[];
}

function resolvePath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: '读取工作目录内的文本文件',
  defaultRisk: 'low',
  inputSchema: {
    type: 'object',
    required: ['filePath'],
    properties: {
      filePath: { type: 'string', description: '相对于工作目录的文件路径' },
      maxLines: { type: 'number', description: '最多读取多少行' },
    },
  },
  validate(input) {
    const issues: string[] = [];
    requireString(input, 'filePath', issues);
    optionalNumber(input, 'maxLines', issues);
    return issues;
  },
  async execute(input, ctx) {
    const filePath = String(input.filePath);
    const maxLines = typeof input.maxLines === 'number' ? input.maxLines : undefined;
    const result = readFile(resolvePath(ctx.cwd, filePath), maxLines);
    return {
      output: result.content.slice(0, 8000),
      data: { filePath: result.filePath, lines: result.lines },
    };
  },
};

const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: '在工作目录内写入文件（自动备份）',
  defaultRisk: 'medium',
  inputSchema: {
    type: 'object',
    required: ['filePath', 'content'],
    properties: {
      filePath: { type: 'string', description: '相对于工作目录的文件路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
  },
  validate(input) {
    const issues: string[] = [];
    requireString(input, 'filePath', issues);
    if (typeof input.content !== 'string') {
      issues.push('content 必须是字符串');
    }
    return issues;
  },
  async execute(input, ctx) {
    const filePath = resolvePath(ctx.cwd, String(input.filePath));
    const result = writeFile(filePath, String(input.content), {
      taskId: ctx.taskId,
      stepId: ctx.stepId,
    });
    return {
      output: `已写入 ${String(input.filePath)} (${result.bytesWritten} 字节)`,
      data: { filePath: result.filePath, bytesWritten: result.bytesWritten },
    };
  },
};

const patchFileTool: ToolDefinition = {
  name: 'patch_file',
  description: '在工作目录内做一次精确文本替换（自动备份）',
  defaultRisk: 'medium',
  inputSchema: {
    type: 'object',
    required: ['filePath', 'oldString', 'newString'],
    properties: {
      filePath: { type: 'string' },
      oldString: { type: 'string' },
      newString: { type: 'string' },
    },
  },
  validate(input) {
    const issues: string[] = [];
    requireString(input, 'filePath', issues);
    if (typeof input.oldString !== 'string' || input.oldString.length === 0) {
      issues.push('oldString 必须是非空字符串');
    }
    if (typeof input.newString !== 'string') {
      issues.push('newString 必须是字符串');
    }
    return issues;
  },
  async execute(input, ctx) {
    const filePath = resolvePath(ctx.cwd, String(input.filePath));
    const result = patchFile(
      filePath,
      String(input.oldString),
      String(input.newString),
      { taskId: ctx.taskId, stepId: ctx.stepId },
    );
    return {
      output: `已修改 ${String(input.filePath)} (${result.linesChanged} 行)`,
      data: { filePath: result.filePath, linesChanged: result.linesChanged },
    };
  },
};

const terminalTool: ToolDefinition = {
  name: 'terminal',
  description: '在工作目录内执行 shell 命令，捕获 stdout/stderr/exitCode',
  defaultRisk: 'medium',
  inputSchema: {
    type: 'object',
    required: ['command'],
    properties: {
      command: { type: 'string' },
      timeoutMs: { type: 'number', description: '超时时间（毫秒）' },
    },
  },
  validate(input) {
    const issues: string[] = [];
    requireString(input, 'command', issues);
    optionalNumber(input, 'timeoutMs', issues);
    return issues;
  },
  async execute(input, ctx) {
    const command = String(input.command);
    const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : 120_000;

    const result = await runCommand(command, {
      cwd: ctx.cwd,
      taskId: ctx.taskId,
      stepId: ctx.stepId,
      timeout: timeoutMs,
      signal: ctx.signal,
      confirmed: ctx.confirmed,
    });

    if (result.timedOut) {
      throw new ToolExecutionError(
        `命令超时 (${timeoutMs}ms): ${command}`,
        result.exitCode,
        result.stdout,
        result.stderr,
      );
    }

    if (result.exitCode !== 0) {
      throw new ToolExecutionError(
        `命令退出码 ${result.exitCode}: ${command}`,
        result.exitCode,
        result.stdout,
        result.stderr,
      );
    }

    const output = result.stdout || result.stderr || `(exit 0) ${command}`;
    return { output, data: result };
  },
};

const gitTool: ToolDefinition = {
  name: 'git',
  description: '执行 Git 操作（status/add/commit/push/branch）',
  defaultRisk: 'medium',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['status', 'add', 'commit', 'push', 'branch'] },
      message: { type: 'string' },
      paths: { type: 'array', items: { type: 'string' } },
      force: { type: 'boolean' },
      name: { type: 'string' },
      remote: { type: 'string' },
      branch: { type: 'string' },
    },
  },
  validate(input) {
    const issues: string[] = [];
    const action = requireString(input, 'action', issues);
    if (action && !['status', 'add', 'commit', 'push', 'branch'].includes(action)) {
      issues.push(`不支持的 git action: ${action}`);
    }
    if (action === 'commit') requireString(input, 'message', issues);
    if (action === 'branch') requireString(input, 'name', issues);
    optionalStringArray(input, 'paths', issues);
    return issues;
  },
  async execute(input, ctx) {
    const action = String(input.action);
    const opts = {
      cwd: ctx.cwd,
      taskId: ctx.taskId,
      stepId: ctx.stepId,
      confirmed: ctx.confirmed,
    };

    switch (action) {
      case 'status': {
        const s = gitUtils.status(ctx.cwd);
        return { output: JSON.stringify(s, null, 2), data: s };
      }
      case 'add': {
        const paths = Array.isArray(input.paths)
          ? (input.paths as string[])
          : ['.'];
        gitUtils.add(paths, opts);
        return { output: `已暂存: ${paths.join(', ')}` };
      }
      case 'commit': {
        const result = gitUtils.commit(String(input.message), opts);
        return {
          output: `提交: ${result.hash} — ${result.message} (${result.filesChanged} 文件)`,
          data: result,
        };
      }
      case 'push': {
        const result = gitUtils.push({
          ...opts,
          force: input.force === true,
          remote: typeof input.remote === 'string' ? input.remote : undefined,
          branch: typeof input.branch === 'string' ? input.branch : undefined,
        });
        return { output: `推送: ${result.branch}`, data: result };
      }
      case 'branch': {
        const result = gitUtils.createBranch(String(input.name), opts);
        return { output: `创建分支: ${result.name}`, data: result };
      }
      default:
        throw new ToolExecutionError(`未知 Git 操作: ${action}`);
    }
  },
};

const askUserTool: ToolDefinition = {
  name: 'ask_user',
  description: '暂停执行，向用户提问并等待回答',
  defaultRisk: 'low',
  inputSchema: {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: { type: 'string' },
    },
  },
  validate(input) {
    const issues: string[] = [];
    requireString(input, 'prompt', issues);
    return issues;
  },
  async execute(input, ctx) {
    if (!ctx.askUser) {
      throw new ToolExecutionError('ask_user 工具没有可用的用户输入通道');
    }
    const answer = await ctx.askUser(String(input.prompt));
    if (answer === null) {
      throw new TaskPausedError('用户中断了 ask_user');
    }
    return { output: answer, data: { answer } };
  },
};

const databaseTool: ToolDefinition = {
  name: 'database',
  description: '数据库操作（尚未实现）',
  defaultRisk: 'high',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  validate() {
    return [];
  },
  async execute() {
    throw new ToolExecutionError('database 工具尚未实现（P2）');
  },
};

const TOOLS: Record<ToolName, ToolDefinition> = {
  read_file: readFileTool,
  write_file: writeFileTool,
  patch_file: patchFileTool,
  terminal: terminalTool,
  git: gitTool,
  ask_user: askUserTool,
  database: databaseTool,
};

export function getTool(name: ToolName): ToolDefinition | undefined {
  return TOOLS[name];
}

export function toolNames(): ToolName[] {
  return Object.keys(TOOLS) as ToolName[];
}

export function validateToolInput(
  name: ToolName,
  input: Record<string, unknown>,
): string[] {
  const tool = getTool(name);
  if (!tool) return [`未知工具: ${name}`];
  return tool.validate(input);
}

export function defaultRiskFor(name: ToolName): RiskLevel {
  return getTool(name)?.defaultRisk ?? 'medium';
}

export function toolSpecForPrompt(): string {
  return Object.values(TOOLS)
    .filter((t) => t.name !== 'database')
    .map((t) => `- ${t.name}: ${JSON.stringify(t.inputSchema)}`)
    .join('\n');
}
