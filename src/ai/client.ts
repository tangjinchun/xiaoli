/**
 * DeepSeek 客户端。
 *
 * 职责：
 *   1. chat() — 非流式对话，带重试与 token 统计
 *   2. chatJson() — JSON 模式对话，解析并返回结构化数据
 *   3. Provider 注入（测评/测试使用脚本化 AI）
 */

import type { AICallOptions, AICallResult, AIMessage } from '../engine/types.js';
import { TaskPausedError } from '../engine/errors.js';
import { hasApiKey, getApiConfig, loadConfig } from '../storage/config.js';
import { modelFor, type ModelKind } from './router.js';
import {
  AIProviderError,
  DeepSeekProvider,
  type ChatProvider,
  type ChatRequest,
} from './provider.js';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;

let injectedProvider: ChatProvider | null = null;
let tokenUsage = { prompt: 0, completion: 0, total: 0 };

export function setChatProvider(provider: ChatProvider | null): void {
  injectedProvider = provider;
}

export function resetChatProvider(): void {
  injectedProvider = null;
}

export function hasAIProvider(): boolean {
  return injectedProvider !== null || hasApiKey();
}

export function getChatProvider(): ChatProvider {
  if (injectedProvider) return injectedProvider;
  const config = getApiConfig();
  return new DeepSeekProvider({ apiKey: config.key, baseUrl: config.baseUrl });
}

export interface ChatRuntimeOptions {
  signal?: AbortSignal;
  kind?: ModelKind;
  model?: string;
}

function buildRequest(
  input: AICallOptions | AIMessage[],
  runtime: ChatRuntimeOptions,
): ChatRequest {
  const config = loadConfig();

  if (Array.isArray(input)) {
    return {
      messages: input,
      model: runtime.model ?? modelFor(runtime.kind),
      maxTokens: 4096,
      temperature: 0.3,
      signal: runtime.signal,
    };
  }

  return {
    messages: [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userMessage },
    ],
    model: input.model ?? runtime.model ?? (runtime.kind === 'fast' ? config.api.modelFlash : config.api.modelPro),
    maxTokens: input.maxTokens ?? 4096,
    temperature: input.temperature ?? 0.3,
    responseFormat: input.responseFormat,
    signal: input.signal ?? runtime.signal,
  };
}

export async function chat(
  input: AICallOptions | AIMessage[],
  runtime: ChatRuntimeOptions = {},
): Promise<AICallResult> {
  const request = buildRequest(input, runtime);
  const provider = getChatProvider();

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (request.signal?.aborted) {
      throw new TaskPausedError();
    }

    try {
      const result = await provider.chat(request);
      tokenUsage.prompt += result.tokenUsage.prompt;
      tokenUsage.completion += result.tokenUsage.completion;
      tokenUsage.total += result.tokenUsage.total;
      return result;
    } catch (err: unknown) {
      if (err instanceof TaskPausedError || request.signal?.aborted) {
        throw new TaskPausedError();
      }

      lastError = err instanceof Error ? err : new Error(String(err));
      const retryable =
        err instanceof AIProviderError
          ? err.retryable
          : /network|timeout|ECONN|429|50[0-9]/.test(lastError.message);

      if (attempt < MAX_RETRIES && retryable) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  throw new Error(
    `AI 调用失败: ${lastError?.message ?? '未知错误'}`,
  );
}

export async function chatJson<T = unknown>(
  options: AICallOptions & { jsonSchema?: string },
): Promise<{ data: T; tokenUsage: AICallResult['tokenUsage'] }> {
  const jsonInstruction =
    '\n\n请只输出 JSON，不要包含任何其他文字、注释或 markdown 标记。';
  const schemaHint = options.jsonSchema
    ? `\n输出必须匹配以下 JSON schema：\n${options.jsonSchema}`
    : '';

  const result = await chat({
    ...options,
    systemPrompt: options.systemPrompt + jsonInstruction + schemaHint,
    responseFormat: 'json_object',
    temperature: options.temperature ?? 0.1,
  });

  let content = result.content.trim();
  if (content.startsWith('```')) {
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }

  try {
    const data = JSON.parse(content) as T;
    return { data, tokenUsage: result.tokenUsage };
  } catch (error) {
    throw new Error(
      `AI 返回的不是有效 JSON: ${(error as Error).message}\n原始响应: ${result.content.slice(0, 300)}`,
    );
  }
}

export function getTokenUsage(): { prompt: number; completion: number; total: number } {
  return { ...tokenUsage };
}

export function resetTokenUsage(): void {
  tokenUsage = { prompt: 0, completion: 0, total: 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
