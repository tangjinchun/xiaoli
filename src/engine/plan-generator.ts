/**
 * 执行计划生成器
 *
 * 拿到用户完整回答后，调用 AI 生成结构化执行计划。
 * 输出包含 phases（阶段分组）和 steps（具体步骤），每步带风险标注。
 *
 * 设计要点：
 *   - phases 分组：诊断→修复→验证 三个阶段
 *   - 每步强制 riskLevel: LOW/MEDIUM/HIGH + riskReason
 *   - 每步有 dependsOn 依赖链、acceptanceCriteria 验收标准
 *   - 计划确认门：用户 review 后 /confirm 确认
 */

import type { AnsweredQuestion, ExecutionPhase, ExecutionPlan, ExecutionStep } from "./types.js";
import { chat } from "../ai/client.js";
import { buildPlanPrompt } from "../ai/prompts/plan-gen.js";

export interface PlanGeneratorConfig {
  /** 最大重试次数 */
  maxRetries?: number;
  /** 是否启用严格模式（Schema 验证失败即报错） */
  strictMode?: boolean;
}

const DEFAULT_CONFIG: Required<PlanGeneratorConfig> = {
  maxRetries: 3,
  strictMode: true,
};

/**
 * 生成执行计划
 */
export async function generatePlan(
  answeredQuestions: AnsweredQuestion[],
  taskDescription: string,
  config: PlanGeneratorConfig = {}
): Promise<ExecutionPlan> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // 构建上下文
  const qaContext = buildQAContext(answeredQuestions);

  // 构建 Prompt
  const prompt = buildPlanPrompt(qaContext, taskDescription);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < cfg.maxRetries; attempt++) {
    try {
      const response = await chat([
        { role: "user", content: prompt },
      ]);

      const parsed = parsePlanResponse(response.content, answeredQuestions);

      // 验证
      const validationErrors = validatePlan(parsed);
      if (validationErrors.length > 0) {
        if (cfg.strictMode) {
          throw new Error(`Plan validation failed: ${validationErrors.join("; ")}`);
        }
        console.warn(`  ⚠️ Plan 验证警告: ${validationErrors.join("; ")}`);
      }

      return parsed;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < cfg.maxRetries - 1) {
        console.warn(`  ⚠️ Plan 生成失败 (${attempt + 1}/${cfg.maxRetries}): ${lastError.message}，重试中...`);
      }
    }
  }

  throw new Error(`Plan 生成失败，已重试 ${cfg.maxRetries} 次: ${lastError?.message}`);
}

// ───── 内部函数 ─────

function buildQAContext(answered: AnsweredQuestion[]): string {
  return answered
    .map((a, i) => {
      const skipTag = a.skipped ? " [已跳过/使用假设]" : "";
      const confTag = a.confidence === "low" ? " [低置信]" : "";
      return `${i + 1}. 问: ${a.question}\n   答: ${a.answer}${skipTag}${confTag}`;
    })
    .join("\n\n");
}

interface RawPlanResponse {
  phases?: RawPhase[];
  steps?: RawStep[];
  summary?: string;
}

interface RawPhase {
  phaseId?: string;
  name?: string;
  purpose?: string;
  steps?: RawStep[];
}

interface RawStep {
  stepId?: string;
  description?: string;
  toolHints?: string[];
  riskLevel?: string;
  riskReason?: string;
  dependsOn?: string[];
  acceptanceCriteria?: string;
  estimatedTime?: string;
}

function parsePlanResponse(response: string, answeredQuestions: AnsweredQuestion[]): ExecutionPlan {
  // 从 AI 返回中提取 JSON
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("AI 返回内容中未找到有效 JSON");
  }

  let raw: RawPlanResponse;
  try {
    raw = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error("AI 返回的 JSON 解析失败");
  }

  const planId = generatePlanId();
  const createdAt = new Date().toISOString();

  let phases: ExecutionPhase[] = [];
  let steps: ExecutionStep[] = [];

  if (raw.phases && raw.phases.length > 0) {
    // 有 phases 分组
    phases = raw.phases.map((rp, pi) => {
      const phaseId = rp.phaseId || `phase-${pi + 1}`;
      const phaseSteps: ExecutionStep[] = (rp.steps || []).map((rs, si) =>
        buildStep(rs, si, pi, phaseId, planId, createdAt)
      );
      steps.push(...phaseSteps);

      return {
        id: phaseId,
        name: rp.name || `阶段 ${pi + 1}`,
        purpose: rp.purpose || "",
        status: "pending" as const,
        dependsOn: [],
        steps: phaseSteps,
        order: pi,
      };
    });
  } else if (raw.steps && raw.steps.length > 0) {
    // 没有 phases，用扁平 steps
    const phaseId = "phase-1";
    const flatSteps = raw.steps.map((rs, si) =>
      buildStep(rs, si, 0, phaseId, planId, createdAt)
    );
    steps = flatSteps;

    phases = [
      {
        id: phaseId,
        name: "执行",
        purpose: raw.summary || "完整执行计划",
        status: "pending",
        dependsOn: [],
        steps: flatSteps,
        order: 0,
      },
    ];
  } else {
    throw new Error("AI 返回的计划不包含 phases 或 steps");
  }

  return {
    id: planId,
    taskDescription: answeredQuestions[0]?.question || "未指定任务",
    phases,
    steps,
    status: "pending",
    createdAt,
    updatedAt: createdAt,
    totalSteps: steps.length,
    completedSteps: 0,
    failedSteps: 0,
    metadata: {
      sourceQuestions: answeredQuestions.length,
      generatedBy: "deepseek",
    },
  };
}

function buildStep(
  rs: RawStep,
  stepIdx: number,
  phaseIdx: number,
  phaseId: string,
  planId: string,
  createdAt: string
): ExecutionStep {
  const riskLevel = normalizeRiskLevel(rs.riskLevel);

  return {
    id: rs.stepId || `${planId}-step-${phaseIdx + 1}-${stepIdx + 1}`,
    phaseId,
    description: rs.description || "",
    toolHints: rs.toolHints || [],
    riskLevel,
    riskReason: rs.riskReason || "",
    dependsOn: rs.dependsOn || [],
    acceptanceCriteria: rs.acceptanceCriteria || "",
    estimatedTime: rs.estimatedTime || "未知",
    status: "pending",
    createdAt,
    updatedAt: createdAt,
    retryCount: 0,
    maxRetries: 3,
  };
}

function normalizeRiskLevel(raw: string | undefined): "low" | "medium" | "high" {
  if (!raw) return "low";
  const normalized = raw.toLowerCase().trim();
  if (normalized === "high" || normalized === "critical") return "high";
  if (normalized === "medium" || normalized === "mid") return "medium";
  return "low";
}

function generatePlanId(): string {
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function validatePlan(plan: ExecutionPlan): string[] {
  const errors: string[] = [];

  if (!plan.phases || plan.phases.length === 0) {
    errors.push("缺少 phases");
  }

  if (!plan.steps || plan.steps.length === 0) {
    errors.push("缺少 steps");
  }

  for (const step of plan.steps) {
    if (!["low", "medium", "high"].includes(step.riskLevel)) {
      errors.push(`步骤 ${step.id} 的 riskLevel 无效: ${step.riskLevel}`);
    }
    if (!step.description) {
      errors.push(`步骤 ${step.id} 缺少 description`);
    }
  }

  // 验证 dependsOn 引用完整性
  const stepIds = new Set(plan.steps.map((s) => s.id));
  for (const step of plan.steps) {
    for (const depId of step.dependsOn) {
      if (!stepIds.has(depId)) {
        errors.push(`步骤 ${step.id} 引用了不存在的依赖 ${depId}`);
      }
    }
  }

  return errors;
}
