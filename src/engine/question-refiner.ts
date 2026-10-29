/**
 * 追问收束器 (L3)。
 *
 * 1. 用可解释的启发式检测信息缺口（作为兜底，也用于给 AI 提供缺口清单）。
 * 2. 有 AI 时调用 AI 生成追加问题；AI 失败时退化为模板问题。
 * 3. 终止条件：零缺口 / 达到轮数上限 / 连续两轮缺口数不下降。
 */

import type { AnsweredQuestion, QuestionSkeleton, RefinementResult } from './types.js';
import { chatJson } from '../ai/client.js';
import {
  REFINEMENT_SYSTEM_PROMPT,
  buildRefinementPrompt,
} from '../ai/prompts/refinement.js';
import { TaskPausedError } from './errors.js';

export interface RefinerConfig {
  maxRounds?: number;
  decayFactor?: number;
  gapThreshold?: number;
  useAI?: boolean;
}

export interface RefinementState {
  /** 已完成的追问轮数（第一轮初始问题算第 1 轮） */
  round: number;
  /** 之前各轮结束时剩余的缺口数 */
  previousRemainingGaps?: number[];
  signal?: AbortSignal;
}

const DEFAULT_CONFIG: Required<RefinerConfig> = {
  maxRounds: 3,
  decayFactor: 0.6,
  gapThreshold: 0.5,
  useAI: true,
};

interface RefinementAIResponse {
  refinement_reasons?: unknown;
  remaining_gaps?: unknown;
  can_terminate?: unknown;
  questions?: unknown;
}

export function detectGaps(
  answered: AnsweredQuestion[],
  previousQuestions: QuestionSkeleton[],
): Map<string, { score: number; reason: string }> {
  const gaps = new Map<string, { score: number; reason: string }>();

  if (answered.length === 0) {
    gaps.set('问题定义', { score: 0.9, reason: '尚未定义问题边界' });
    gaps.set('成功标准', { score: 0.8, reason: '缺少可量化的成功标准' });
    gaps.set('边界约束', { score: 0.7, reason: '约束条件未知' });
    return gaps;
  }

  const uncertainAnswers = answered.filter(
    (a) =>
      a.answer.includes('不清楚') ||
      a.answer.includes('不确定') ||
      a.answer.includes('没定义') ||
      a.answer.includes('不知道') ||
      a.confidence === 'low',
  );
  if (uncertainAnswers.length > 0) {
    gaps.set('问题定义', {
      score: 0.8,
      reason: `有 ${uncertainAnswers.length} 个回答不明确: ${uncertainAnswers
        .map((a) => a.question.slice(0, 20))
        .join(', ')}`,
    });
  }

  const negativeAnswers = answered.filter(
    (a) =>
      a.answer.includes('不行') ||
      a.answer.includes('不能') ||
      a.answer.includes('不可以') ||
      a.answer.includes('不涉及'),
  );
  if (negativeAnswers.length > 0) {
    gaps.set('边界约束', {
      score: Math.min(0.9, negativeAnswers.length * 0.3),
      reason: `${negativeAnswers.length} 个约束被否定: ${negativeAnswers
        .map((a) => a.answer.slice(0, 30))
        .join('; ')}`,
    });
  }

  const hasQuantitative = answered.some(
    (a) => /\d+/.test(a.answer) && /[秒分时天个次元万%]/.test(a.answer),
  );
  if (!hasQuantitative) {
    gaps.set('成功标准', {
      score: 0.7,
      reason: '缺少可量化的成功标准（如响应时间、文件内容、验收命令）',
    });
  }

  const envKeywords = ['环境', '系统', '版本', '平台', '操作系统', '浏览器', '数据库', '框架'];
  const askedEnv = previousQuestions.some((q) =>
    envKeywords.some((kw) => q.question.includes(kw)),
  );
  const hasEnvMention = answered.some((a) =>
    envKeywords.some((kw) => a.answer.includes(kw) || a.question.includes(kw)),
  );
  if (askedEnv && !hasEnvMention) {
    gaps.set('环境约束', { score: 0.6, reason: '运行环境细节未确认' });
  }

  const techKeywords = ['技术', '方案', '架构', '协议', 'API', '库', '组件', '依赖'];
  const askedTech = previousQuestions.some((q) =>
    techKeywords.some((kw) => q.question.includes(kw)),
  );
  const hasTechMention = answered.some((a) =>
    techKeywords.some((kw) => a.answer.includes(kw) || a.question.includes(kw)),
  );
  if (askedTech && !hasTechMention) {
    gaps.set('技术细节', { score: 0.6, reason: '技术方案细节缺失' });
  }

  const timeKeywords = ['截止', '交付', '上线', '发布时间', '星期', '月', '天', '周'];
  const hasTimeMention = answered.some((a) =>
    timeKeywords.some((kw) => a.answer.includes(kw) || a.question.includes(kw)),
  );
  if (!hasTimeMention) {
    gaps.set('时间线', { score: 0.5, reason: '时间窗口未明确' });
  }

  return gaps;
}

export function gradientDecay(previousCount: number, config: RefinerConfig = {}): number {
  const factor = config.decayFactor ?? DEFAULT_CONFIG.decayFactor;
  return Math.max(1, Math.floor(previousCount * factor));
}

export function canTerminate(
  remainingGaps: number,
  round: number,
  previousRemainingGaps: number[],
  config: RefinerConfig = {},
): boolean {
  const maxRounds = config.maxRounds ?? DEFAULT_CONFIG.maxRounds;

  if (remainingGaps === 0) return true;
  if (round >= maxRounds) return true;

  const history = [...previousRemainingGaps, remainingGaps];
  if (history.length >= 2) {
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    if (last === prev) return true;
  }

  return false;
}

function normalizeQuestions(raw: unknown, maxQuestions: number): QuestionSkeleton[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, maxQuestions)
    .map((item, index) => {
      const q = item as Record<string, unknown>;
      return {
        id: typeof q.id === 'string' && q.id ? q.id : `q-refine-${index + 1}`,
        question: typeof q.question === 'string' ? q.question.trim() : '',
        category: typeof q.category === 'string' ? q.category : '补充信息',
        expectedAnswerType: q.expectedAnswerType === 'detail' ? 'detail' : 'short',
        priority:
          q.priority === 'high' || q.priority === 'low' || q.priority === 'medium'
            ? q.priority
            : 'medium',
      } satisfies QuestionSkeleton;
    })
    .filter((q) => q.question.length > 0);
}

function heuristicQuestions(
  gaps: Map<string, { score: number; reason: string }>,
  maxQuestions: number,
): QuestionSkeleton[] {
  return Array.from(gaps.entries())
    .slice(0, maxQuestions)
    .map(([dim, info], index) => ({
      id: `q-refine-${index + 1}`,
      question: `关于「${dim}」: ${info.reason}，请补充说明。`,
      category: dim,
      expectedAnswerType: 'short' as const,
      priority: index === 0 ? ('high' as const) : ('medium' as const),
    }));
}

export async function generateRefinementQuestions(
  answered: AnsweredQuestion[],
  previousQuestions: QuestionSkeleton[],
  state: RefinementState,
  config: RefinerConfig = {},
): Promise<RefinementResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const gaps = detectGaps(answered, previousQuestions);
  const realGaps = Array.from(gaps.entries()).filter(
    ([, v]) => v.score >= (config.gapThreshold ?? DEFAULT_CONFIG.gapThreshold),
  );
  const maxNew = gradientDecay(previousQuestions.length, config);
  const history = state.previousRemainingGaps ?? [];

  if (
    realGaps.length === 0 ||
    canTerminate(realGaps.length, state.round, history, config)
  ) {
    return {
      refinementReasons: realGaps.map(([dim, info]) => `[${dim}] ${info.reason}`),
      newQuestions: [],
      remainingGaps: realGaps.length,
      canTerminate: true,
    };
  }

  if (state.signal?.aborted) {
    throw new TaskPausedError();
  }

  if (cfg.useAI) {
    try {
      const { data } = await chatJson<RefinementAIResponse>({
        systemPrompt: REFINEMENT_SYSTEM_PROMPT,
        userMessage: buildRefinementPrompt(
          answered,
          previousQuestions,
          gaps,
          maxNew,
          state.round + 1,
        ),
        temperature: 0.1,
        maxTokens: 1600,
        signal: state.signal,
      });

      const questions = normalizeQuestions(data.questions, maxNew);
      const remaining =
        typeof data.remaining_gaps === 'number' && data.remaining_gaps >= 0
          ? data.remaining_gaps
          : realGaps.length;
      const reasons = Array.isArray(data.refinement_reasons)
        ? data.refinement_reasons.filter((r): r is string => typeof r === 'string')
        : realGaps.map(([dim, info]) => `[${dim}] ${info.reason}`);

      const terminate =
        data.can_terminate === true ||
        remaining === 0 ||
        questions.length === 0 ||
        canTerminate(remaining, state.round, history, config);

      return {
        refinementReasons: reasons,
        newQuestions: terminate ? [] : questions,
        remainingGaps: remaining,
        canTerminate: terminate,
      };
    } catch (err) {
      if (err instanceof TaskPausedError) throw err;
      // AI 失败时退化到启发式，不阻塞主流程。
    }
  }

  const questions = heuristicQuestions(new Map(realGaps), maxNew);
  const terminate =
    questions.length === 0 ||
    canTerminate(realGaps.length, state.round, history, config);

  return {
    refinementReasons: realGaps.map(([dim, info]) => `[${dim}] ${info.reason}`),
    newQuestions: terminate ? [] : questions,
    remainingGaps: realGaps.length,
    canTerminate: terminate,
  };
}
