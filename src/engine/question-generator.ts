/**
 * 追问生成器 (L2)。
 *
 * 基于用户任务 + L1 上下文，调用 AI 生成追问。
 * 输出通过 chatJson 强制为 { questions: [...] }。
 */

import { chatJson } from '../ai/client.js';
import {
  buildQuestionGenSystemPrompt,
  parseQuestionGenResponse,
} from '../ai/prompts/question-gen.js';
import type { QuestionSkeleton } from './types.js';
import { TaskPausedError } from './errors.js';

export interface QuestionGenerationOptions {
  signal?: AbortSignal;
}

export async function generateQuestions(
  taskDescription: string,
  projectContext?: string,
  options: QuestionGenerationOptions = {},
): Promise<QuestionSkeleton[]> {
  try {
    const { data } = await chatJson<{ questions?: QuestionSkeleton[] } | QuestionSkeleton[]>({
      systemPrompt: buildQuestionGenSystemPrompt(projectContext),
      userMessage: taskDescription,
      temperature: 0.2,
      maxTokens: 2048,
      signal: options.signal,
    });

    return parseQuestionGenResponse(JSON.stringify(data));
  } catch (err) {
    if (err instanceof TaskPausedError) throw err;
    throw new Error(`追问生成失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
