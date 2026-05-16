/**
 * xiaoli 核心类型定义
 *
 * 所有模块的依赖基础。无任何运行时依赖。
 * 对齐文档 05_追问与执行计划设计.md 的数据结构。
 */

// ============================================================================
// 追问系统 (L1 → L2 → L3)
// ============================================================================

/** 追问分类（字符串，与 05 文档的 6 大类对齐） */
export type QuestionCategory = string;

/** 单个追问（L2 生成器输出 / L3 梯度递减输入） */
export interface QuestionSkeleton {
  /** 唯一标识 */
  id: string;
  /** 问题文本（中文） */
  question: string;
  /** 分类标签 */
  category: string;
  /** 期望回答类型：short=简短回答, detail=详细说明 */
  expectedAnswerType: "short" | "detail";
  /** 优先级：high=必答, medium=建议答, low=可选 */
  priority: "high" | "medium" | "low";
}

/** 用户自由文本回答的输入 */
export interface AnswerInput {
  /** 用户原始输入文本 */
  raw: string;
}

/** 已回答的问题（回答收集器输出） */
export interface AnsweredQuestion {
  /** 关联的问题 ID */
  questionId: string;
  /** 问题原文（冗余存储，方便查阅） */
  question: string;
  /** 用户的回答文本 */
  answer: string;
  /** 置信度：high=明确回答, low=模糊回答 */
  confidence: "high" | "low";
  /** 是否被用户跳过 */
  skipped: boolean;
  /** 回答时间 */
  answeredAt: string;
}

/** L3 追问收束结果 */
export interface RefinementResult {
  /** 为什么需要追加追问的理由列表 */
  refinementReasons: string[];
  /** 新增的追问列表（梯度递减后） */
  newQuestions: QuestionSkeleton[];
  /** 剩余信息缺口数 */
  remainingGaps: number;
  /** 是否可以终止追问 */
  canTerminate: boolean;
}

// ============================================================================
// 执行计划 (Plan)
// ============================================================================

// ============================================================================
// AI 客户端
// ============================================================================

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AICallOptions {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: "text" | "json_object";
}

export interface AICallResult {
  content: string;
  tokenUsage: { prompt: number; completion: number; total: number };
  model: string;
}

// ============================================================================
// 配置
// ============================================================================

export interface XiaoliConfig {
  api: {
    provider: string;
    key: string;
    baseUrl: string;
    modelPro: string;
    modelFlash: string;
  };
  safety: {
    requireDangerousConfirm: boolean;
    maxAutoRetry: number;
    auditLogPath: string;
  };
  ui: {
    color: boolean;
    progressBars: boolean;
    compactMode: boolean;
  };
}

// ============================================================================
// 执行计划
// ============================================================================

/** 风险等级 */
export type RiskLevel = "low" | "medium" | "high";

/** 工具名称 */
export type ToolName = "read_file" | "write_file" | "terminal" | "git" | "database" | "ask_user";

/** 计划整体状态 */
export type PlanStatus = "pending" | "confirmed" | "running" | "paused" | "completed" | "failed";

/** 阶段状态 */
export type PhaseStatus = "pending" | "running" | "completed" | "failed";

/** 步骤状态 */
export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

/** 执行计划（完整结构，对齐 05 文档 ExecutionPlan JSON Schema） */
export interface ExecutionPlan {
  /** 计划唯一 ID */
  id: string;
  /** 任务描述（用户原始输入） */
  taskDescription: string;
  /** 阶段列表（诊断→修复→验证） */
  phases: ExecutionPhase[];
  /** 平面化步骤列表（所有 phase 的 step 合集，方便遍历） */
  steps: ExecutionStep[];
  /** 计划状态 */
  status: PlanStatus;
  /** 时间戳 */
  createdAt: string;
  updatedAt: string;
  /** 完成时间 */
  completedAt?: string;
  /** 统计 */
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  /** 元数据 */
  metadata: {
    sourceQuestions: number;
    generatedBy: string;
  };
}

/** 执行阶段 */
export interface ExecutionPhase {
  /** 阶段唯一 ID */
  id: string;
  /** 阶段名称 */
  name: string;
  /** 阶段目的（一句话描述） */
  purpose: string;
  /** 阶段状态 */
  status: PhaseStatus;
  /** 依赖的阶段 ID 列表 */
  dependsOn: string[];
  /** 阶段内的步骤 */
  steps: ExecutionStep[];
  /** 顺序（从 0 开始） */
  order: number;
}

/** 执行步骤 */
export interface ExecutionStep {
  /** 步骤唯一 ID */
  id: string;
  /** 所属阶段 ID */
  phaseId: string;
  /** 步骤描述 */
  description: string;
  /** 推荐使用的工具列表 */
  toolHints: string[];
  /** 风险等级 */
  riskLevel: RiskLevel;
  /** 风险原因说明 */
  riskReason: string;
  /** 依赖的步骤 ID 列表 */
  dependsOn: string[];
  /** 验收标准（可量化） */
  acceptanceCriteria: string;
  /** 预计耗时 */
  estimatedTime: string;
  /** 步骤状态 */
  status: StepStatus;
  /** 时间戳 */
  createdAt: string;
  updatedAt: string;
  /** 当前重试次数 */
  retryCount: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 实际耗时 */
  actualTime?: string;
  /** 执行开始时间 */
  startedAt?: string;
  /** 执行完成时间 */
  completedAt?: string;

  // ── 向后兼容（旧 executor.ts 用） ──
  /** @deprecated 用 toolHints[0] */
  tool?: string;
  /** @deprecated 用 description 推断 */
  input?: Record<string, unknown>;
  /** @deprecated 待移除 */
  attempts?: number;
  /** @deprecated 用 maxRetries */
  maxAttempts?: number;
  /** @deprecated 待移除 */
  rollback?: { description: string; tool: string; input: Record<string, unknown> };
  /** @deprecated 待移除 */
  fallback?: { description: string; tool: string; input: Record<string, unknown> };
  /** @deprecated 待移除 */
  expectedOutput?: string;
}
