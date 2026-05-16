/**
 * 回答智能解析器
 * 将用户自由文本回答匹配到 QuestionSkeleton 的问题列表
 * 支持三种输入模式：
 *   1. 序号模式：1. 答案一 2. 答案二
 *   2. 序号+多行模式：1. 第一行\n第二行\n3. 第三行
 *   3. 纯文本模式：关键词匹配
 */

import type { AnswerInput, QuestionSkeleton } from "./types.js";

interface ParsedAnswer {
  questionIndex: number;
  questionId: string;
  answer: string;
  confidence: number; // 0~1, ≥0.7 算高置信
}

interface ParseResult {
  answers: ParsedAnswer[];
  unmatched: string[];
  coveragePercent: number;
  highConfidenceCount: number;
}

/**
 * 解析用户输入的回答文本，尝试匹配到对应的问题
 */
export function parseAnswers(
  input: AnswerInput,
  questions: QuestionSkeleton[]
): ParseResult {
  if (!input.raw?.trim()) {
    return { answers: [], unmatched: [], coveragePercent: 0, highConfidenceCount: 0 };
  }

  // 先尝试序号解析
  const numbered = parseNumbered(input.raw, questions);
  if (numbered.answers.length > 0) {
    return numbered;
  }

  // 退化为纯文本匹配
  return parseFreeText(input.raw, questions);
}

// ───── 序号解析 ─────

function parseNumbered(raw: string, questions: QuestionSkeleton[]): ParseResult {
  // 匹配 "1. xxx" / "1) xxx" / "1、xxx" / "【1】xxx"
  const lines = raw.split(/\n/);
  const entries: { num: number; text: string }[] = [];
  let currentNum: number | null = null;
  let currentText = "";

  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s*[.、)】]\s*(.*)$/);
    if (match) {
      if (currentNum !== null) {
        entries.push({ num: currentNum, text: currentText.trim() });
      }
      currentNum = parseInt(match[1], 10);
      currentText = match[2];
    } else if (currentNum !== null) {
      currentText += "\n" + line;
    }
  }
  if (currentNum !== null) {
    entries.push({ num: currentNum, text: currentText.trim() });
  }

  if (entries.length === 0) {
    return { answers: [], unmatched: [], coveragePercent: 0, highConfidenceCount: 0 };
  }

  // 把序号映射到 questions 数组（questions 从 0 开始，序号从 1 开始）
  const answers: ParsedAnswer[] = [];
  const unmatched: string[] = [];

  for (const entry of entries) {
    const questionIndex = entry.num - 1;
    if (questionIndex >= 0 && questionIndex < questions.length) {
      answers.push({
        questionIndex,
        questionId: questions[questionIndex].id,
        answer: entry.text,
        confidence: 1.0, // 序号匹配，高置信
      });
    } else {
      unmatched.push(entry.text);
    }
  }

  const coveragePercent = questions.length > 0
    ? Math.round((answers.length / questions.length) * 100)
    : 0;

  return {
    answers,
    unmatched,
    coveragePercent,
    highConfidenceCount: answers.length,
  };
}

// ───── 纯文本匹配 ─────

function parseFreeText(raw: string, questions: QuestionSkeleton[]): ParseResult {
  const answers: ParsedAnswer[] = [];
  const unmatched: string[] = [];

  // 按句号/换行分句
  const sentences = raw
    .split(/[。\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    let bestMatch: { index: number; score: number } | null = null;

    for (let i = 0; i < questions.length; i++) {
      // 检查是否已经回答过这个问题
      if (answers.some((a) => a.questionIndex === i)) continue;

      const score = keywordScore(sentence, questions[i]);
      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { index: i, score };
      }
    }

    if (bestMatch && bestMatch.score >= 0.3) {
      // 将低分匹配也收进来，但标注低置信
      const confidence = Math.min(1.0, bestMatch.score * 1.5);
      answers.push({
        questionIndex: bestMatch.index,
        questionId: questions[bestMatch.index].id,
        answer: sentence,
        confidence,
      });
    } else {
      unmatched.push(sentence);
    }
  }

  const coveragePercent = questions.length > 0
    ? Math.round((answers.length / questions.length) * 100)
    : 0;

  const highConfidenceCount = answers.filter((a) => a.confidence >= 0.7).length;

  return { answers, unmatched, coveragePercent, highConfidenceCount };
}

// ───── 关键词评分 ─────

function keywordScore(sentence: string, question: QuestionSkeleton): number {
  // 从问题文本中提取关键词
  const keywords = extractKeywords(question.question);
  if (keywords.length === 0) return 0.2; // 无关键词时给低分

  const sentenceLower = sentence.toLowerCase();
  let hits = 0;

  for (const kw of keywords) {
    if (sentenceLower.includes(kw.toLowerCase())) {
      hits++;
    }
  }

  return hits / keywords.length;
}

function extractKeywords(text: string): string[] {
  // 提取有意义的词（长度≥2 的连续中文字符，或长度≥3 的英文单词）
  const chinese = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const english = text.match(/[a-zA-Z]{3,}/g) || [];

  // 过滤掉泛词
  const stopWords = new Set([
    "什么", "怎么", "哪些", "哪个", "有没有", "是不是", "是否",
    "可以", "需要", "可能", "应该", "这个", "那个", "如何",
  ]);

  return [...chinese, ...english].filter((w) => !stopWords.has(w));
}

// ───── 格式化输出 ─────

export function formatParseResult(result: ParseResult, questions: QuestionSkeleton[]): string {
  if (result.answers.length === 0) {
    return "⚠️ 未能匹配任何问题。请尝试用序号格式回答，如：\n  1. 你的答案 2. 你的答案";
  }

  const lines: string[] = [];
  for (const a of result.answers) {
    const q = questions[a.questionIndex];
    const confIcon = a.confidence >= 0.7 ? "✅" : "⚠️";
    lines.push(`  ${confIcon} Q${a.questionIndex + 1}: "${q.question.slice(0, 40)}..." → ${a.answer.slice(0, 50)}`);
  }

  if (result.unmatched.length > 0) {
    lines.push(`  ⚠️ 未能匹配: ${result.unmatched.slice(0, 3).join(" | ")}`);
  }

  lines.push(`\n  置信度: ${result.highConfidenceCount}/${result.answers.length} 高 | 匹配率: ${result.coveragePercent}%`);

  return lines.join("\n");
}
