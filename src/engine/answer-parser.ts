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
  // 支持一行多个序号："1. 甲 2. 乙"，也支持多行。
  // 要求序号后至少有一个空格，避免把 "MySQL 8.0" 里的 8. 误判成序号。
  let matches = Array.from(raw.matchAll(/(?:^|\s)(\d+)\s*[.、)】]\s+/g));
  if (matches.length === 0) {
    // 中文/括号分隔符后面可以没有空格："1、答案" / "1)答案" / "1】答案"
    matches = Array.from(raw.matchAll(/(?:^|\s)(\d+)\s*[、)】]\s*/g));
  }
  const entries: { num: number; text: string }[] = [];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index ?? raw.length : raw.length;
    const text = raw.slice(start, end).trim();
    entries.push({ num: parseInt(match[1], 10), text });
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

  // 只有一个问题时，用户往往直接说答案，不必强求关键词命中。
  if (questions.length === 1) {
    return {
      answers: [
        {
          questionIndex: 0,
          questionId: questions[0].id,
          answer: raw.trim(),
          confidence: 0.6,
        },
      ],
      unmatched: [],
      coveragePercent: 100,
      highConfidenceCount: 0,
    };
  }

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

    if (bestMatch && bestMatch.score >= 0.2) {
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
  if (keywords.length === 0) return 0.1; // 无关键词时几乎不匹配

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
  // 中文没有空格，用 2-gram 近似分词；英文取长度 >= 3 的词。
  const chinese = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  const english = text.match(/[a-zA-Z]{3,}/g) || [];
  const words: string[] = [];

  for (const run of chinese) {
    if (run.length <= 4) words.push(run);
    for (let i = 0; i <= run.length - 2; i++) {
      words.push(run.slice(i, i + 2));
    }
  }
  words.push(...english);

  // 过滤掉泛词
  const stopWords = new Set([
    "什么", "怎么", "哪些", "哪个", "有没有", "是不是", "是否",
    "可以", "需要", "可能", "应该", "这个", "那个", "如何",
  ]);

  return [...new Set(words)].filter((w) => !stopWords.has(w));
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
