/**
 * 追问生成器 (L2)
 *
 * 基于用户任务 + L1 上下文，调用 AI 生成 6 大维度的追问。
 * 对应 05 文档 §2「追问生成 Prompt」。
 */

import { chat } from "../ai/client.js";
import {
  buildQuestionGenSystemPrompt,
  parseQuestionGenResponse,
} from "../ai/prompts/question-gen.js";
import type { QuestionSkeleton } from "./types.js";

/**
 * 生成追问列表
 *
 * @param taskDescription - 用户任务描述
 * @param projectContext - 可选：L1 上下文（用于精准追问）
 * @returns 追问列表（最多 8 个）
 */
export async function generateQuestions(
  taskDescription: string,
  projectContext?: string
): Promise<QuestionSkeleton[]> {
  const systemPrompt = buildQuestionGenSystemPrompt(projectContext);

  try {
    const result = await chat({
      systemPrompt,
      userMessage: taskDescription,
      temperature: 0.3,
      maxTokens: 2048,
      responseFormat: "json_object",
    });

    return parseQuestionGenResponse(result.content);
  } catch (err) {
    throw new Error(
      `追问生成失败: ${err instanceof Error ? err.message : err}`
    );
  }
}
