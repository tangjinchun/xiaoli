/**
 * 执行计划生成器。
 *
 * 拿到用户完整回答后，调用 AI 生成结构化计划，再用 plan-compiler
 * 编译成执行器可以消费的 IR。
 */

import type { AnsweredQuestion, ExecutionPlan } from './types.js';
import { chatJson } from '../ai/client.js';
import { buildPlanPrompt } from '../ai/prompts/plan-gen.js';
import { compilePlan, type RawPlan } from './plan-compiler.js';
import { PlanValidationError, TaskPausedError } from './errors.js';

export interface PlanGeneratorConfig {
  maxRetries?: number;
  strictMode?: boolean;
}

export interface PlanGenerationContext {
  cwd?: string;
  signal?: AbortSignal;
}

const DEFAULT_CONFIG: Required<PlanGeneratorConfig> = {
  maxRetries: 3,
  strictMode: true,
};

const PLAN_SYSTEM_PROMPT = `你是一个技术主管，需要把用户需求和追问结果编译成可执行的开发计划。
计划中的每一步都必须是具体工具调用，并给出 tool 和 input。
你了解的工具只有 read_file、write_file、patch_file、terminal、git、ask_user。
请只输出 JSON 对象。`;

function buildQAContext(answered: AnsweredQuestion[]): string {
  return answered
    .map((a, i) => {
      const skipTag = a.skipped ? ' [已跳过/使用假设]' : '';
      const confTag = a.confidence === 'low' ? ' [低置信]' : '';
      return `${i + 1}. 问: ${a.question}\n   答: ${a.answer}${skipTag}${confTag}`;
    })
    .join('\n\n');
}

export async function generatePlan(
  answeredQuestions: AnsweredQuestion[],
  taskDescription: string,
  config: PlanGeneratorConfig = {},
  context: PlanGenerationContext = {},
): Promise<ExecutionPlan> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const qaContext = buildQAContext(answeredQuestions);
  let prompt = buildPlanPrompt(qaContext, taskDescription);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < cfg.maxRetries; attempt++) {
    try {
      const { data } = await chatJson<RawPlan>({
        systemPrompt: PLAN_SYSTEM_PROMPT,
        userMessage: prompt,
        maxTokens: 6000,
        temperature: 0.1,
        signal: context.signal,
      });

      return compilePlan(data, taskDescription, {
        cwd: context.cwd ?? process.cwd(),
        generatedBy: 'deepseek',
        sourceQuestions: answeredQuestions.length,
      });
    } catch (err) {
      if (err instanceof TaskPausedError) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));

      const isValidation =
        err instanceof PlanValidationError ||
        lastError.message.includes('JSON') ||
        lastError.message.includes('schema');

      if (!isValidation) {
        throw lastError;
      }

      if (attempt < cfg.maxRetries - 1) {
        prompt += `\n\n上一次输出无法执行，原因是：\n${lastError.message}\n请修正后重新输出完整 JSON。`;
      }
    }
  }

  throw new Error(
    `Plan 生成失败，已重试 ${cfg.maxRetries} 次: ${lastError?.message ?? '未知错误'}`,
  );
}
