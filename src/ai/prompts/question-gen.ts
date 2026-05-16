/**
 * 追问生成 Prompt 模板
 *
 * 对应设计文档 §5.1
 * 职责：基于用户任务和项目上下文，生成 6 大维度的追问
 */

import type { QuestionSkeleton } from "../../engine/types.js";

/**
 * 构建追问生成的 system prompt
 * @param projectContext - 可选：L1 上下文注入的项目信息
 */
export function buildQuestionGenSystemPrompt(projectContext?: string): string {
  const contextBlock = projectContext
    ? `\n## 当前项目上下文\n${projectContext}\n\n请利用这些上下文提出更精准的问题。`
    : "";

  return `你是一个需求澄清助手。用户会描述一个任务，你需要提出追问来明确需求。

## 追问维度
你必须从以下 6 个维度覆盖追问：

1. **问题定义** — 当前不清楚的问题是什么？具体表现？
2. **边界约束** — 有什么限制条件？（技术、组织、预算、时间）
3. **成功标准** — 做到什么程度算成功？（量化指标）
4. **环境约束** — 运行在什么环境？（系统、版本、依赖）
5. **技术细节** — 技术上有什么要求？（方案、协议、框架）
6. **时间线** — 截止日期？优先级？依赖关系？

## 规则
- 最多提 8 个问题（不要超过）
- 不问能从已有信息推断出的问题
- 问题具体、可回答（回答不超过一句话）
- 问题必须有意义——不问废话
- 按优先级排序：高优先级的放前面
${contextBlock}
请输出 JSON 数组（只输出 JSON）：
[
  {
    "id": "q-1",
    "question": "...",
    "category": "问题定义",
    "expectedAnswerType": "short",
    "priority": "high"
  }
]`;
}

/**
 * 解析 AI 返回的追问 JSON
 */
export function parseQuestionGenResponse(raw: string): QuestionSkeleton[] {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) {
      throw new Error("AI 返回的不是数组");
    }

    return parsed.map((q: Record<string, unknown>, i: number) => ({
      id: (q.id as string) || `q-${i + 1}`,
      question: (q.question as string) || "",
      category: (q.category as string) || "问题定义",
      expectedAnswerType: (q.expectedAnswerType as "short" | "detail") || "short",
      priority: (q.priority as "high" | "medium" | "low") || "medium",
    }));
  } catch (err) {
    throw new Error(`追问 JSON 解析失败: ${err instanceof Error ? err.message : err}`);
  }
}
