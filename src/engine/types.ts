/**
 * xiaoli 核心类型定义。
 *
 * 执行计划是可编译、可校验、可恢复的中间表示（IR）：
 * 每一步都必须是具体工具调用，而不是自然语言描述。
 */

// ============================================================================
// 追问系统 (L1 → L2 → L3)
// ============================================================================

export type QuestionCategory = string;

export interface QuestionSkeleton {
  /** 问题唯一标识。落库后会被替换为数据库行 ID。 */
  id: string;
  /** 问题文本（中文） */
  question: string;
  /** 分类标签 */
  category: string;
  /** 期望回答类型 */
  expectedAnswerType: 'short' | 'detail';
  /** 优先级 */
  priority: 'high' | 'medium' | 'low';
  /** 第几轮追问，从 1 开始 */
  round?: number;
}

export interface AnswerInput {
  raw: string;
}

export interface AnsweredQuestion {
  questionId: string;
  question: string;
  answer: string;
  confidence: 'high' | 'low';
  skipped: boolean;
  answeredAt: string;
}

export interface RefinementResult {
  refinementReasons: string[];
  newQuestions: QuestionSkeleton[];
  remainingGaps: number;
  canTerminate: boolean;
}

// ============================================================================
// AI 客户端
// ============================================================================

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AICallOptions {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json_object';
  signal?: AbortSignal;
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

export type RiskLevel = 'low' | 'medium' | 'high';

export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'patch_file'
  | 'terminal'
  | 'git'
  | 'ask_user'
  | 'database';

export type TaskStatus =
  | 'questioning'
  | 'planning'
  | 'plan_ready'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'rejected';

export type PlanStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'rejected';

export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed';

export type StepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'paused';

/** 步骤执行后的确定性验收规则。 */
export type VerifySpec =
  | { type: 'file_exists'; path: string }
  | { type: 'file_not_exists'; path: string }
  | { type: 'file_contains'; path: string; text: string }
  | { type: 'stdout_contains'; text: string }
  | { type: 'command'; command: string; expectedExitCode?: number };

export interface ExecutionPlan {
  id: string;
  taskDescription: string;
  summary?: string;
  phases: ExecutionPhase[];
  /** 扁平化步骤列表，顺序即默认执行顺序 */
  steps: ExecutionStep[];
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  metadata: {
    sourceQuestions: number;
    generatedBy: string;
  };
}

export interface ExecutionPhase {
  id: string;
  name: string;
  purpose: string;
  status: PhaseStatus;
  dependsOn: string[];
  steps: ExecutionStep[];
  order: number;
}

export interface ExecutionStep {
  id: string;
  phaseId: string;
  description: string;
  /** 执行该步骤的工具 */
  tool: ToolName;
  /** 工具参数，必须是具体值而不是自然语言 */
  input: Record<string, unknown>;
  /** 仅用于展示的推荐工具 */
  toolHints?: string[];
  riskLevel: RiskLevel;
  riskReason: string;
  dependsOn: string[];
  acceptanceCriteria: string;
  /** 可选的确定性验收规则 */
  verify?: VerifySpec;
  estimatedTime: string;
  status: StepStatus;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  maxAttempts: number;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
  rollback?: {
    description: string;
    tool: ToolName;
    input: Record<string, unknown>;
  };
  fallback?: {
    description: string;
    tool: ToolName;
    input: Record<string, unknown>;
  };
}

export type PlanDecision = 'confirm' | 'reject' | 'pause';
