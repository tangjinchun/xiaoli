/**
 * 追问收束器 (L3)
 *
 * 收到用户对 L2 追问的回答后，检测信息缺口，生成梯度递减的追问。
 * 核心规则：
 *   - 6 维缺口检测：每维 0.0~1.0 分，≥0.5 为真缺口
 *   - 梯度递减：本轮问题数 ≤ 上轮 × 0.6，最少 1 个
 *   - 终止条件：零缺口 / 3 轮上限 / 连续两轮缺口数不变（收敛）
 *   - 回答不了可跳过，标记为「假设」
 */

import type { AnsweredQuestion, QuestionSkeleton, RefinementResult } from "./types.js";

export interface RefinerConfig {
  maxRounds?: number;
  decayFactor?: number;
  gapThreshold?: number;
}

const DEFAULT_CONFIG: Required<RefinerConfig> = {
  maxRounds: 3,
  decayFactor: 0.6,
  gapThreshold: 0.5,
};

/**
 * 分析已回答的问题，检测信息缺口
 */
export function detectGaps(
  answered: AnsweredQuestion[],
  previousQuestions: QuestionSkeleton[]
): Map<string, { score: number; reason: string }> {
  const gaps = new Map<string, { score: number; reason: string }>();

  if (answered.length === 0) {
    // 还没有任何回答，所有维度都是缺口
    gaps.set("问题定义", { score: 0.9, reason: "尚未定义问题边界" });
    gaps.set("边界约束", { score: 0.9, reason: "约束条件未知" });
    gaps.set("成功标准", { score: 0.9, reason: "缺少可量化的成功标准" });
    gaps.set("环境约束", { score: 0.7, reason: "运行环境未确认" });
    gaps.set("技术细节", { score: 0.7, reason: "技术方案未知" });
    gaps.set("时间线", { score: 0.8, reason: "时间窗口未指定" });
    return gaps;
  }

  // 检查「问题定义」
  const uncertainAnswers = answered.filter(
    (a) =>
      a.answer.includes("不清楚") ||
      a.answer.includes("不确定") ||
      a.answer.includes("没定义") ||
      a.answer.includes("不知道") ||
      a.confidence === "low"
  );
  if (uncertainAnswers.length > 0) {
    gaps.set("问题定义", {
      score: 0.8,
      reason: `有 ${uncertainAnswers.length} 个回答不明确: ${uncertainAnswers.map((a) => a.question.slice(0, 20)).join(", ")}`,
    });
  }

  // 检查「边界约束」：是否有否定性回答
  const negativeAnswers = answered.filter(
    (a) =>
      a.answer.includes("不行") ||
      a.answer.includes("不能") ||
      a.answer.includes("不可以") ||
      a.answer.includes("没有") ||
      a.answer.includes("不涉及")
  );
  if (negativeAnswers.length > 0) {
    const score = Math.min(0.9, negativeAnswers.length * 0.3);
    gaps.set("边界约束", {
      score,
      reason: `${negativeAnswers.length} 个约束被否定: ${negativeAnswers.map((a) => a.answer.slice(0, 30)).join("; ")}`,
    });
  }

  // 检查「成功标准」：是否有量化指标
  const hasQuantitative = answered.some(
    (a) =>
      /\d+/.test(a.answer) &&
      /[秒分时天个次元万%\]]/.test(a.answer)
  );
  if (!hasQuantitative) {
    gaps.set("成功标准", {
      score: 0.7,
      reason: "缺少可量化的成功标准（如响应时间、错误率等）",
    });
  }

  // 检查「环境约束」：关键字检测
  const envKeywords = ["环境", "系统", "版本", "平台", "操作系统", "浏览器", "数据库", "框架"];
  const hasEnvMention = answered.some((a) =>
    envKeywords.some((kw) => a.answer.includes(kw) || a.question.includes(kw))
  );
  if (!hasEnvMention && previousQuestions.some((q) => envKeywords.some((kw) => q.question.includes(kw)))) {
    gaps.set("环境约束", {
      score: 0.6,
      reason: "运行环境细节未确认",
    });
  }

  // 检查「技术细节」：关键字检测
  const techKeywords = ["技术", "方案", "架构", "协议", "API", "库", "组件", "依赖"];
  const hasTechMention = answered.some((a) =>
    techKeywords.some((kw) => a.answer.includes(kw) || a.question.includes(kw))
  );
  if (!hasTechMention && previousQuestions.some((q) => techKeywords.some((kw) => q.question.includes(kw)))) {
    gaps.set("技术细节", {
      score: 0.6,
      reason: "技术方案细节缺失",
    });
  }

  // 检查「时间线」
  const timeKeywords = ["截止", "交付", "上线", "发布时间", "星期", "月", "天", "周"];
  const hasTimeMention = answered.some((a) =>
    timeKeywords.some((kw) => a.answer.includes(kw) || a.question.includes(kw))
  );
  if (!hasTimeMention) {
    gaps.set("时间线", {
      score: 0.5,
      reason: "时间窗口未明确",
    });
  }

  return gaps;
}

/**
 * 梯度递减：计算本轮允许的最大追问数
 */
export function gradientDecay(previousCount: number, config: RefinerConfig = {}): number {
  const factor = config.decayFactor ?? DEFAULT_CONFIG.decayFactor;
  return Math.max(1, Math.floor(previousCount * factor));
}

/**
 * 判断是否可以终止追问
 */
export function canTerminate(
  remainingGaps: number,
  round: number,
  previousRemainingGaps: number[],
  config: RefinerConfig = {}
): boolean {
  const maxRounds = config.maxRounds ?? DEFAULT_CONFIG.maxRounds;

  // 零缺口
  if (remainingGaps === 0) return true;

  // 达到轮数上限
  if (round >= maxRounds) return true;

  // 连续两轮缺口数不变（收敛）
  if (previousRemainingGaps.length >= 2) {
    const last = previousRemainingGaps[previousRemainingGaps.length - 1];
    const secondLast = previousRemainingGaps[previousRemainingGaps.length - 2];
    if (last === remainingGaps && secondLast === last) {
      return true;
    }
  }

  return false;
}

/**
 * 构建追问收束 Prompt 使用的已回答问题摘要
 */
export function buildRefinementContext(answered: AnsweredQuestion[]): string {
  return answered
    .map((a, i) => {
      const confidenceTag = a.confidence === "low" ? " [低置信]" : a.skipped ? " [已跳过]" : "";
      return `${i + 1}. 问: ${a.question}\n   答: ${a.answer}${confidenceTag}`;
    })
    .join("\n\n");
}

/**
 * 构建追问收束 Prompt
 */
export function buildRefinementPrompt(
  answered: AnsweredQuestion[],
  previousQuestions: QuestionSkeleton[],
  gaps: Map<string, { score: number; reason: string }>,
  maxNewQuestions: number
): string {
  const context = buildRefinementContext(answered);
  const gapList = Array.from(gaps.entries())
    .filter(([, v]) => v.score >= 0.5)
    .map(([dim, v]) => `  - ${dim} (${v.score.toFixed(1)}): ${v.reason}`)
    .join("\n");

  const previousQList = previousQuestions
    .map((q, i) => `${i + 1}. [${q.category}] ${q.question}`)
    .join("\n");

  return `你是一个需求澄清助手。用户已经回答了一轮问题，现在需要你根据信息缺口提出最多 ${maxNewQuestions} 个追加问题。

【已回答的问题和回答】
${context}

【原始问题列表】
${previousQList}

【检测到的信息缺口】
${gapList || "（无明显缺口——如果确实没有信息缺口，返回空问题列表）"}

【约束】
- 最多提出 ${maxNewQuestions} 个问题
- 不问已回答过的问题
- 不问能从已有回答推断出的问题
- 如果缺口清单为空，返回空列表
- 用和原始问题相同的 JSON 格式输出

请输出 JSON：
{
  "refinement_reasons": ["为什么需要追加这些问题的理由"],
  "remaining_gaps": ${gaps.size},
  "can_terminate": ${gaps.size === 0},
  "questions": [
    {
      "id": "q-refine-1",
      "question": "...",
      "category": "边界约束",
      "expectedAnswerType": "short",
      "priority": "high"
    }
  ]
}`;
}

/**
 * 生成梯度递减后的追问列表
 */
export function generateRefinementQuestions(
  answered: AnsweredQuestion[],
  previousQuestions: QuestionSkeleton[],
  config: RefinerConfig = {}
): RefinementResult {
  const gaps = detectGaps(answered, previousQuestions);
  const realGaps = Array.from(gaps.entries()).filter(([, v]) => v.score >= (config.gapThreshold ?? DEFAULT_CONFIG.gapThreshold));
  const maxNew = gradientDecay(previousQuestions.length, config);

  // 为每个真缺口生成一个追问
  const questions: QuestionSkeleton[] = realGaps.slice(0, maxNew).map(([dim, info], i) => ({
    id: `q-refine-${i + 1}`,
    question: `关于「${dim}」: ${info.reason}，请补充说明。`,
    category: dim,
    expectedAnswerType: "short" as const,
    priority: i === 0 ? "high" : ("medium" as const),
  }));

  const refinementReasons = realGaps.map(([dim, info]) => `[${dim}] ${info.reason}`);

  return {
    refinementReasons,
    newQuestions: questions,
    remainingGaps: realGaps.length,
    canTerminate: canTerminate(realGaps.length, 1, [], config),
  };
}
