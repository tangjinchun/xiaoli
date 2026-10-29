/**
 * 脚本化 AI Provider。
 *
 * 根据 system prompt 中的标记返回预设 JSON，用于离线测评运行时行为。
 * 它不评估模型质量，只保证问答/计划/执行链路可重复。
 */

import type { ChatProvider, ChatRequest } from '../src/ai/provider.js';
import type { AICallResult } from '../src/engine/types.js';
import type { EvalRefinement } from './types.js';
import type { QuestionSkeleton } from '../src/engine/types.js';
import type { RawPlan } from '../src/engine/plan-compiler.js';

export interface ScriptedResponses {
  questions: QuestionSkeleton[];
  plan: RawPlan;
  refinement?: EvalRefinement;
}

export class ScriptedProvider implements ChatProvider {
  constructor(private readonly responses: ScriptedResponses) {}

  async chat(request: ChatRequest): Promise<AICallResult> {
    const text = request.messages.map((m) => m.content).join('\n');

    let content: string;
    if (text.includes('追问收束')) {
      content = JSON.stringify({
        refinement_reasons:
          this.responses.refinement?.reasons ?? ['需要补充执行细节'],
        remaining_gaps: this.responses.refinement?.remaining_gaps ?? 1,
        can_terminate: this.responses.refinement?.can_terminate ?? false,
        questions: this.responses.refinement?.questions ?? [],
      });
    } else if (text.includes('需求澄清助手')) {
      content = JSON.stringify({ questions: this.responses.questions });
    } else if (text.includes('技术主管')) {
      content = JSON.stringify(this.responses.plan);
    } else {
      throw new Error('ScriptedProvider: 无法识别的请求');
    }

    return {
      content,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      model: 'scripted',
    };
  }
}
