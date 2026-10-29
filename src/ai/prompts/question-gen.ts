/**
 * 追问生成 Prompt 模板。
 *
 * 输出必须是 JSON 对象 { questions: [...] }，与 json_object 模式兼容。
 */

import type { QuestionSkeleton } from '../../engine/types.js';

export function buildQuestionGenSystemPrompt(projectContext?: string): string {
  const contextBlock = projectContext
    ? `\n## 当前项目上下文\n${projectContext}\n\n请利用这些上下文提出更精准的问题；能从上下文中推断的信息不要问。`
    : '';

  return `你是一个需求澄清助手。用户会描述一个任务，你需要提出追问来明确需求。

## 追问维度
尽可能覆盖以下维度，但只问真正会影响执行的：
1. 问题定义 — 当前不清楚的问题是什么？具体表现？
2. 边界约束 — 有什么限制条件？（技术、组织、预算、时间）
3. 成功标准 — 做到什么程度算成功？（量化指标）
4. 环境约束 — 运行在什么环境？（系统、版本、依赖）
5. 技术细节 — 技术上有什么要求？（方案、协议、框架）
6. 时间线 — 截止日期？优先级？依赖关系？

## 规则
- 最多提 8 个问题
- 不问能从已有信息或项目上下文推断出的问题
- 问题具体、可回答（回答不超过一句话）
- 按优先级排序：高优先级的放前面
${contextBlock}
请输出 JSON 对象（只输出 JSON）：
{
  "questions": [
    {
      "id": "q-1",
      "question": "...",
      "category": "问题定义",
      "expectedAnswerType": "short",
      "priority": "high"
    }
  ]
}`;
}

export function parseQuestionGenResponse(raw: string): QuestionSkeleton[] {
  let parsed: unknown;
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`追问 JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { questions?: unknown }).questions)
      ? (parsed as { questions: unknown[] }).questions
      : null;

  if (!list) {
    throw new Error('追问 JSON 必须是数组或 { questions: [...] }');
  }

  return list
    .slice(0, 8)
    .map((item, i) => {
      const q = item as Record<string, unknown>;
      return {
        id: typeof q.id === 'string' && q.id ? q.id : `q-${i + 1}`,
        question: typeof q.question === 'string' ? q.question.trim() : '',
        category: typeof q.category === 'string' ? q.category : '问题定义',
        expectedAnswerType: q.expectedAnswerType === 'detail' ? 'detail' : 'short',
        priority:
          q.priority === 'high' || q.priority === 'low' || q.priority === 'medium'
            ? q.priority
            : 'medium',
      } satisfies QuestionSkeleton;
    })
    .filter((q) => q.question.length > 0);
}
