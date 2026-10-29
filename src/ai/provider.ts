/**
 * AI Provider 抽象。
 *
 * 默认实现走 DeepSeek（OpenAI 兼容接口）；测评可以注入脚本化 provider，
 * 从而在无网络、无 API key 的情况下验证完整的问答/计划/执行链路。
 */

import OpenAI from 'openai';
import type { AIMessage, AICallResult } from '../engine/types.js';
import { TaskPausedError } from '../engine/errors.js';

export interface ChatRequest {
  messages: AIMessage[];
  model: string;
  maxTokens: number;
  temperature: number;
  responseFormat?: 'text' | 'json_object';
  signal?: AbortSignal;
}

export interface ChatProvider {
  chat(request: ChatRequest): Promise<AICallResult>;
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}

export interface DeepSeekProviderOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
}

export class DeepSeekProvider implements ChatProvider {
  private readonly client: OpenAI;

  constructor(options: DeepSeekProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      timeout: options.timeoutMs ?? 120_000,
      maxRetries: 0,
    });
  }

  async chat(request: ChatRequest): Promise<AICallResult> {
    if (request.signal?.aborted) {
      throw new TaskPausedError();
    }

    try {
      const response = await this.client.chat.completions.create(
        {
          model: request.model,
          messages: request.messages as OpenAI.Chat.ChatCompletionMessageParam[],
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          response_format:
            request.responseFormat === 'json_object' ? { type: 'json_object' } : undefined,
        },
        { signal: request.signal },
      );

      const choice = response.choices[0];
      const content = choice?.message?.content;
      if (!content) {
        throw new AIProviderError('AI 返回空响应', undefined, true);
      }

      return {
        content,
        tokenUsage: {
          prompt: response.usage?.prompt_tokens ?? 0,
          completion: response.usage?.completion_tokens ?? 0,
          total: response.usage?.total_tokens ?? 0,
        },
        model: response.model,
      };
    } catch (err: unknown) {
      if (err instanceof TaskPausedError) throw err;
      if (request.signal?.aborted) throw new TaskPausedError();

      const e = err as {
        status?: number;
        message?: string;
        name?: string;
        code?: string;
      };
      const status = e.status;
      const retryable =
        status === 408 ||
        status === 409 ||
        status === 429 ||
        (typeof status === 'number' && status >= 500) ||
        e.code === 'ECONNRESET' ||
        e.code === 'ETIMEDOUT' ||
        e.name === 'APIConnectionError';

      throw new AIProviderError(
        e.message ?? 'AI 调用失败',
        status,
        retryable,
      );
    }
  }
}
