/**
 * 执行计划编译器。
 *
 * 把模型返回的自然语言计划编译成可执行的 IR：
 *   - 每步必须有 tool + input
 *   - 参数按工具 schema 校验
 *   - 依赖关系检查 + 拓扑排序
 *   - 风险等级由策略引擎兜底抬高
 */

import type {
  ExecutionPhase,
  ExecutionPlan,
  ExecutionStep,
  RiskLevel,
  ToolName,
  VerifySpec,
} from './types.js';
import { PlanValidationError } from './errors.js';
import {
  defaultRiskFor,
  getTool,
  toolNames,
  validateToolInput,
} from './tool-registry.js';
import { checkPath, evaluateShell, evaluateToolCall } from '../safety/policy.js';

export interface RawStep {
  stepId?: unknown;
  description?: unknown;
  tool?: unknown;
  input?: unknown;
  toolHints?: unknown;
  riskLevel?: unknown;
  riskReason?: unknown;
  dependsOn?: unknown;
  acceptanceCriteria?: unknown;
  verify?: unknown;
  estimatedTime?: unknown;
  maxAttempts?: unknown;
  rollback?: unknown;
  fallback?: unknown;
}

export interface RawPhase {
  phaseId?: unknown;
  name?: unknown;
  purpose?: unknown;
  steps?: unknown;
}

export interface RawPlan {
  summary?: unknown;
  phases?: unknown;
  steps?: unknown;
}

export interface CompileOptions {
  cwd?: string;
  generatedBy?: string;
  sourceQuestions?: number;
}

const TOOL_ALIASES: Record<string, ToolName> = {
  shell: 'terminal',
  bash: 'terminal',
  command: 'terminal',
  exec: 'terminal',
  file_read: 'read_file',
  read: 'read_file',
  file_write: 'write_file',
  write: 'write_file',
  edit_file: 'patch_file',
  patch: 'patch_file',
  replace: 'patch_file',
  git_operation: 'git',
  user: 'ask_user',
  ask: 'ask_user',
};

function normalizeTool(raw: unknown): ToolName | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if ((toolNames() as string[]).includes(value)) return value as ToolName;
  return TOOL_ALIASES[value] ?? null;
}

function normalizeRisk(raw: unknown): RiskLevel | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  if (value === 'critical') return 'high';
  if (value === 'mid') return 'medium';
  return null;
}

function asString(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function parseInput(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function firstDefined(input: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (input[key] !== undefined) return input[key];
  }
  return undefined;
}

function normalizeInput(tool: ToolName, raw: Record<string, unknown>): Record<string, unknown> {
  const input = { ...raw };

  switch (tool) {
    case 'read_file': {
      const filePath = firstDefined(input, ['filePath', 'file', 'path']);
      return {
        filePath,
        maxLines: input.maxLines,
      };
    }
    case 'write_file': {
      return {
        filePath: firstDefined(input, ['filePath', 'file', 'path']),
        content: firstDefined(input, ['content', 'text', 'data']),
      };
    }
    case 'patch_file': {
      return {
        filePath: firstDefined(input, ['filePath', 'file', 'path']),
        oldString: firstDefined(input, ['oldString', 'old_string', 'find']),
        newString: firstDefined(input, ['newString', 'new_string', 'replace']),
      };
    }
    case 'terminal': {
      return {
        command: firstDefined(input, ['command', 'cmd', 'script']),
        timeoutMs: firstDefined(input, ['timeoutMs', 'timeout']),
      };
    }
    case 'git': {
      const rawAction = asString(input.action);
      const actionMap: Record<string, string> = {
        create_branch: 'branch',
        branch_create: 'branch',
        commit_all: 'commit',
      };
      return {
        action: actionMap[rawAction] ?? rawAction,
        message: input.message,
        paths: input.paths,
        force: input.force,
        name: firstDefined(input, ['name', 'branchName']),
        remote: input.remote,
        branch: input.branch,
      };
    }
    case 'ask_user': {
      return { prompt: firstDefined(input, ['prompt', 'question', 'message']) };
    }
    default:
      return input;
  }
}

function normalizeVerify(raw: unknown, cwd: string, issues: string[]): VerifySpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  const type = asString(v.type);

  switch (type) {
    case 'file_exists':
    case 'file_not_exists': {
      const p = asString(v.path);
      if (!p) {
        issues.push(`${type} 缺少 path`);
        return undefined;
      }
      const policy = checkPath(cwd, p, 'read');
      if (policy.verdict === 'STOP') {
        issues.push(`${type} 路径不安全: ${policy.reason}`);
        return undefined;
      }
      return { type, path: p };
    }
    case 'file_contains': {
      const p = asString(v.path);
      const text = asString(v.text);
      if (!p || !text) {
        issues.push('file_contains 需要 path 和 text');
        return undefined;
      }
      const policy = checkPath(cwd, p, 'read');
      if (policy.verdict === 'STOP') {
        issues.push(`file_contains 路径不安全: ${policy.reason}`);
        return undefined;
      }
      return { type, path: p, text };
    }
    case 'stdout_contains': {
      const text = asString(v.text);
      if (!text) {
        issues.push('stdout_contains 缺少 text');
        return undefined;
      }
      return { type, text };
    }
    case 'command': {
      const command = asString(v.command);
      if (!command) {
        issues.push('command verify 缺少 command');
        return undefined;
      }
      const policy = evaluateShell(command, cwd);
      if (policy.verdict === 'STOP' || policy.verdict === 'ASK') {
        issues.push(`verify 命令必须是低风险命令: ${policy.reason}`);
        return undefined;
      }
      const expected = typeof v.expectedExitCode === 'number' ? v.expectedExitCode : 0;
      return { type, command, expectedExitCode: expected };
    }
    default:
      issues.push(`未知 verify 类型: ${type || '(空)'}`);
      return undefined;
  }
}

function normalizeNestedAction(
  raw: unknown,
  cwd: string,
  issues: string[],
  label: string,
): { description: string; tool: ToolName; input: Record<string, unknown> } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const tool = normalizeTool(obj.tool);
  if (!tool) {
    issues.push(`${label} 缺少合法 tool`);
    return undefined;
  }
  const input = parseInput(obj.input);
  if (!input) {
    issues.push(`${label} 缺少合法 input`);
    return undefined;
  }
  const normalized = normalizeInput(tool, input);
  const inputIssues = validateToolInput(tool, normalized);
  if (inputIssues.length > 0) {
    issues.push(`${label} 参数不合法: ${inputIssues.join('; ')}`);
    return undefined;
  }
  const policy = evaluateToolCall(tool, normalized, cwd);
  if (policy.verdict === 'STOP') {
    issues.push(`${label} 被安全策略拒绝: ${policy.reason}`);
    return undefined;
  }
  return {
    description: asString(obj.description) || label,
    tool,
    input: normalized,
  };
}

export function compilePlan(
  raw: unknown,
  taskDescription: string,
  options: CompileOptions = {},
): ExecutionPlan {
  const cwd = options.cwd ?? process.cwd();
  const issues: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlanValidationError('计划必须是 JSON 对象', ['顶层不是对象']);
  }

  const document = raw as RawPlan;
  const rawPhases: RawPhase[] = [];
  let flatRawSteps: RawStep[] = [];

  if (Array.isArray(document.phases) && document.phases.length > 0) {
    for (const p of document.phases) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        issues.push('phase 必须是对象');
        continue;
      }
      rawPhases.push(p as RawPhase);
    }
  } else if (Array.isArray(document.steps) && document.steps.length > 0) {
    flatRawSteps = document.steps as RawStep[];
  } else {
    throw new PlanValidationError('计划不包含 phases 或 steps', ['缺少 phases/steps']);
  }

  const planId = `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  const phases: ExecutionPhase[] = [];
  const allSteps: ExecutionStep[] = [];
  const seenIds = new Set<string>();

  const buildPhase = (rawPhase: RawPhase, phaseIndex: number, rawSteps: RawStep[]): ExecutionPhase => {
    const phaseId = asString(rawPhase.phaseId) || `phase-${phaseIndex + 1}`;
    const stepObjects: ExecutionStep[] = [];

    rawSteps.forEach((rawStep, stepIndex) => {
      if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) {
        issues.push(`${phaseId} 的第 ${stepIndex + 1} 步不是对象`);
        return;
      }

      const description = asString(rawStep.description);
      if (!description) {
        issues.push(`${phaseId} 的第 ${stepIndex + 1} 步缺少 description`);
        return;
      }

      const toolFromHints = Array.isArray(rawStep.toolHints)
        ? normalizeTool((rawStep.toolHints as unknown[])[0])
        : null;
      const tool = normalizeTool(rawStep.tool) ?? toolFromHints;
      if (!tool) {
        issues.push(`${phaseId} 的第 ${stepIndex + 1} 步缺少合法 tool`);
        return;
      }

      const parsedInput = parseInput(rawStep.input);
      if (!parsedInput) {
        issues.push(`${phaseId} 的第 ${stepIndex + 1} 步缺少可执行 input`);
        return;
      }

      const input = normalizeInput(tool, parsedInput);
      const inputIssues = validateToolInput(tool, input);
      if (inputIssues.length > 0) {
        issues.push(`${phaseId} 的第 ${stepIndex + 1} 步参数不合法: ${inputIssues.join('; ')}`);
        return;
      }

      let stepId = asString(rawStep.stepId) || `${phaseId}-step-${stepIndex + 1}`;
      if (seenIds.has(stepId)) {
        issues.push(`重复的 stepId: ${stepId}`);
        return;
      }
      seenIds.add(stepId);

      let riskLevel = normalizeRisk(rawStep.riskLevel) ?? defaultRiskFor(tool);
      let riskReason = asString(rawStep.riskReason);
      const policy = evaluateToolCall(tool, input, cwd);
      if (policy.verdict === 'STOP' || policy.verdict === 'ASK') {
        riskLevel = 'high';
        riskReason = [riskReason, policy.reason].filter(Boolean).join('\n');
      } else if (policy.verdict === 'WARN' && riskLevel === 'low') {
        riskLevel = 'medium';
        riskReason = [riskReason, policy.reason].filter(Boolean).join('\n');
      }

      const verify = normalizeVerify(rawStep.verify, cwd, issues);
      const maxAttemptsRaw = typeof rawStep.maxAttempts === 'number' ? rawStep.maxAttempts : 2;
      const maxAttempts = Math.min(3, Math.max(1, Math.round(maxAttemptsRaw)));

      const step: ExecutionStep = {
        id: stepId,
        phaseId,
        description,
        tool,
        input,
        toolHints: Array.isArray(rawStep.toolHints)
          ? (rawStep.toolHints as unknown[]).filter((v): v is string => typeof v === 'string')
          : [tool],
        riskLevel,
        riskReason,
        dependsOn: asStringArray(rawStep.dependsOn),
        acceptanceCriteria: asString(rawStep.acceptanceCriteria),
        verify,
        estimatedTime: asString(rawStep.estimatedTime) || '未知',
        status: 'pending',
        createdAt,
        updatedAt: createdAt,
        attempts: 0,
        maxAttempts,
        rollback: normalizeNestedAction(rawStep.rollback, cwd, issues, `${stepId} 的 rollback`),
        fallback: normalizeNestedAction(rawStep.fallback, cwd, issues, `${stepId} 的 fallback`),
      };

      stepObjects.push(step);
      allSteps.push(step);
    });

    return {
      id: phaseId,
      name: asString(rawPhase.name) || `阶段 ${phaseIndex + 1}`,
      purpose: asString(rawPhase.purpose),
      status: 'pending',
      dependsOn: [],
      steps: stepObjects,
      order: phaseIndex,
    };
  };

  if (rawPhases.length > 0) {
    rawPhases.forEach((p, index) => {
      const steps = Array.isArray(p.steps) ? (p.steps as RawStep[]) : [];
      phases.push(buildPhase(p, index, steps));
    });
  } else {
    phases.push(
      buildPhase(
        { phaseId: 'phase-1', name: '执行', purpose: asString(document.summary) || '完整执行计划' },
        0,
        flatRawSteps,
      ),
    );
  }

  if (allSteps.length === 0) {
    issues.push('计划没有任何可执行步骤');
  }

  // 依赖完整性 + 环检测
  const ids = new Set(allSteps.map((s) => s.id));
  for (const step of allSteps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) {
        issues.push(`步骤 ${step.id} 引用了不存在的依赖 ${dep}`);
      }
    }
  }

  if (issues.length === 0) {
    try {
      topoSortSteps(allSteps);
    } catch (err) {
      issues.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (issues.length > 0) {
    throw new PlanValidationError('计划校验失败', issues);
  }

  return {
    id: planId,
    taskDescription,
    summary: asString(document.summary),
    phases,
    steps: allSteps,
    status: 'ready',
    createdAt,
    updatedAt: createdAt,
    totalSteps: allSteps.length,
    completedSteps: 0,
    failedSteps: 0,
    skippedSteps: 0,
    metadata: {
      sourceQuestions: options.sourceQuestions ?? 0,
      generatedBy: options.generatedBy ?? 'deepseek',
    },
  };
}

/**
 * 按依赖关系拓扑排序；同一层保持原顺序。
 */
export function topoSortSteps(steps: ExecutionStep[]): ExecutionStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const index = new Map(steps.map((s, i) => [s.id, i]));
  const indegree = new Map<string, number>(steps.map((s) => [s.id, 0]));
  const outgoing = new Map<string, string[]>(steps.map((s) => [s.id, []]));

  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!byId.has(dep)) {
        throw new PlanValidationError('依赖不存在', [`${step.id} -> ${dep}`]);
      }
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      outgoing.get(dep)!.push(step.id);
    }
  }

  const ready = steps
    .filter((s) => (indegree.get(s.id) ?? 0) === 0)
    .sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));

  const result: ExecutionStep[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    result.push(current);

    const next = outgoing.get(current.id) ?? [];
    for (const id of next) {
      const degree = (indegree.get(id) ?? 0) - 1;
      indegree.set(id, degree);
      if (degree === 0) {
        ready.push(byId.get(id)!);
        ready.sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
      }
    }
  }

  if (result.length !== steps.length) {
    const cyclic = steps.filter((s) => !result.some((r) => r.id === s.id)).map((s) => s.id);
    throw new PlanValidationError('计划依赖存在环', cyclic);
  }

  return result;
}

export function findTool(name: string): ToolName | null {
  return normalizeTool(name);
}

export function toolExists(name: string): boolean {
  return getTool(normalizeTool(name) as ToolName) !== undefined;
}
