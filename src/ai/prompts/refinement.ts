/**
 * 追问收束 Prompt。
 *
 * 输入：已回答的问题 + 检测到的信息缺口
 * 输出：最多 N 个追加问题（JSON）
 */

import type { AnsweredQuestion, QuestionSkeleton } from '../../engine/types.js';

export const REFINEMENT_SYSTEM_PROMPT = `你是一个需求澄清助手，负责追问收束。
用户已经回答了一轮问题。你需要判断还有哪些信息缺口会实质影响执行计划，
只问那些“答案会改变计划”的问题，不要重复已经问过的内容。
请只输出 JSON 对象。`;

export function buildRefinementContext(answered: AnsweredQuestion[]): string {
  return answered
    .map((a, i) => {
      const tag = a.skipped ? ' [已跳过]' : a.confidence === 'low' ? ' [低置信]' : '';
      return `${i + 1}. 问: ${a.question}\n   答: ${a.answer || '（未回答）'}${tag}`;
    })
    .join('\n\n');
}

export function buildRefinementPrompt(
  answered: AnsweredQuestion[],
  previousQuestions: QuestionSkeleton[],
  gaps: Map<string, { score: number; reason: string }>,
  maxNewQuestions: number,
  round: number,
): string {
  const context = buildRefinementContext(answered);
  const gapList = Array.from(gaps.entries())
    .filter(([, v]) => v.score >= 0.5)
    .map(([dim, v]) => `  - ${dim} (${v.score.toFixed(1)}): ${v.reason}`)
    .join('\n');

  const previousQList = previousQuestions
    .map((q, i) => `${i + 1}. [${q.category}] ${q.question}`)
    .join('\n');

  return `这是第 ${round} 轮追问收束。请根据信息缺口提出最多 ${maxNewQuestions} 个追加问题。

【已回答的问题和回答】
${context || '（暂无）'}

【之前问过的问题】
${previousQList || '（暂无）'}

【检测到的信息缺口】
${gapList || '（无明显缺口）'}

【约束】
- 最多提出 ${maxNewQuestions} 个问题
- 不问已回答过的问题
- 不问能从已有回答或项目上下文推断出的问题
- 如果缺口清单为空，返回空问题列表
- 问题要具体、一句话可回答

请输出 JSON：
{
  "refinement_reasons": ["为什么需要追加这些问题"],
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
