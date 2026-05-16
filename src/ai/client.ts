/**
 * DeepSeek API 客户端
 *
 * 封装 OpenAI 兼容 API 调用，base_url 指向 api.deepseek.com。
 *
 * 职责：
 *   1. chat() — 非流式对话（追问生成、计划生成）
 *   2. chatJson() — JSON 模式对话（强制输出 JSON）
 *   3. 重试机制（网络瞬断自动重试）
 *   4. Token 使用统计
 */

import OpenAI from 'openai';
import { getApiConfig } from '../storage/config.js';
import type { AICallOptions, AICallResult, AIMessage } from '../engine/types.js';

/** 最大重试次数 */
const MAX_RETRIES = 3;
/** 重试等待基数（毫秒） */
const RETRY_BASE_MS = 1000;

/**
 * 创建 OpenAI 客户端实例（指向 DeepSeek）
 */
function createClient(): OpenAI {
  const apiConfig = getApiConfig();
  return new OpenAI({
    apiKey: apiConfig.key,
    baseURL: apiConfig.baseUrl,
  });
}

/**
 * 发起一次非流式对话。
 *
 * @param options - 调用选项（model, systemPrompt, userMessage, maxTokens, temperature, responseFormat）
 * @returns AI 调用结果（content + token 统计）
 */
export async function chat(options: AICallOptions): Promise<AICallResult>;
export async function chat(messages: AIMessage[]): Promise<AICallResult>;
export async function chat(optionsOrMessages: AICallOptions | AIMessage[]): Promise<AICallResult> {
  const apiConfig = getApiConfig();
  const client = createClient();

  let messages: AIMessage[];
  let model: string;
  let maxTokens: number;
  let temperature: number;
  let responseFormat: "text" | "json_object" | undefined;

  if (Array.isArray(optionsOrMessages)) {
    messages = optionsOrMessages;
    model = apiConfig.modelPro;
    maxTokens = 4096;
    temperature = 0.3;
    responseFormat = undefined;
  } else {
    messages = [
      { role: 'system', content: optionsOrMessages.systemPrompt },
      { role: 'user', content: optionsOrMessages.userMessage },
    ];
    model = optionsOrMessages.model ?? apiConfig.modelPro;
    maxTokens = optionsOrMessages.maxTokens ?? 4096;
    temperature = optionsOrMessages.temperature ?? 0.3;
    responseFormat = optionsOrMessages.responseFormat;
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        max_tokens: maxTokens,
        temperature,
        response_format:
          responseFormat === 'json_object'
            ? { type: 'json_object' }
            : undefined,
      });

      const choice = response.choices[0];
      if (!choice?.message?.content) {
        throw new Error('AI 返回空响应');
      }

      return {
        content: choice.message.content,
        tokenUsage: {
          prompt: response.usage?.prompt_tokens ?? 0,
          completion: response.usage?.completion_tokens ?? 0,
          total: response.usage?.total_tokens ?? 0,
        },
        model: response.model,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const isRateLimit =
        lastError.message.includes('429') ||
        lastError.message.includes('rate');
      const isServerError =
        lastError.message.includes('500') ||
        lastError.message.includes('502') ||
        lastError.message.includes('503');

      // 只对可恢复的错误重试
      if (attempt < MAX_RETRIES && (isRateLimit || isServerError)) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        console.warn(
          `⚠ AI 调用失败 (${lastError.message.slice(0, 80)})，${delay / 1000}s 后重试 (${attempt}/${MAX_RETRIES})...`
        );
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  throw new Error(
    `AI 调用失败（已重试 ${MAX_RETRIES} 次）: ${lastError?.message ?? '未知错误'}`
  );
}

/**
 * 发起 JSON 模式对话。自动添加 JSON 输出指令。
 *
 * @param options - 调用选项（responseFormat 强制设为 json_object）
 * @returns 解析后的 JSON 对象
 */
export async function chatJson<T = unknown>(
  options: AICallOptions & { jsonSchema?: string }
): Promise<{ data: T; tokenUsage: AICallResult["tokenUsage"] }> {
  // 在系统提示词末尾追加 JSON 输出指令
  const jsonInstruction =
    '\n\n请只输出 JSON，不要包含任何其他文字、注释或 markdown 标记。';
  const schemaHint = options.jsonSchema
    ? `\n输出必须匹配以下 JSON schema：\n${options.jsonSchema}`
    : '';

  const result = await chat({
    ...options,
    systemPrompt: options.systemPrompt + jsonInstruction + schemaHint,
    responseFormat: 'json_object',
    // JSON 模式需要较低温度
    temperature: options.temperature ?? 0.1,
  });

  try {
    // 去除可能的 markdown 代码块包裹
    let content = result.content.trim();
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    }

    const data = JSON.parse(content) as T;
    return { data, tokenUsage: result.tokenUsage };
  } catch (error) {
    throw new Error(
      `AI 返回的不是有效 JSON: ${(error as Error).message}\n原始响应: ${result.content.slice(0, 200)}`
    );
  }
}

/**
 * 获取当前 Token 用量（占位，后续集成持久化统计）
 */
export function getTokenUsage(): { prompt: number; completion: number; total: number } {
  // TODO: 持久化 token 统计到 SQLite
  return { prompt: 0, completion: 0, total: 0 };
}

/** Promise-based sleep */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
