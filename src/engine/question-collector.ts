/**
 * 追问交互收集器 (L2)
 * 在终端中向用户展示 AI 生成的追问，交互式收集回答
 *
 * 核心特性:
 *   - 不用按个回答，用户想到什么说什么
 *   - 支持序号格式 (推荐): 1. 答案 2. 答案
 *   - 多轮循环: 没答完的下一轮继续问
 *   - skip 跳过本轮
 */

import * as readline from "node:readline";
import type { AnswerInput, AnsweredQuestion, QuestionSkeleton } from "./types.js";
import { parseAnswers, formatParseResult } from "./answer-parser.js";

export interface CollectorConfig {
  /** 每轮最多展示的问题数 */
  maxPerRound?: number;
  /** 是否显示问题类别标签 */
  showCategory?: boolean;
}

export interface CollectorResult {
  answered: AnsweredQuestion[];
  skipped: string[];
  totalRounds: number;
}

/**
 * 交互式收集用户对追问的回答
 */
export async function collectAnswers(
  questions: QuestionSkeleton[],
  config: CollectorConfig = {}
): Promise<CollectorResult> {
  const { maxPerRound = 8, showCategory = true } = config;

  const answered: AnsweredQuestion[] = [];
  const skipped: string[] = [];
  let round = 0;

  console.log(`\n  📋 xiaoli 有 ${questions.length} 个问题需要问你。`);
  console.log("  你不需要按顺序回答，想到什么说什么。");
  console.log("  用序号格式回答效果最好，比如：");
  console.log("    1. 甲级写字楼 2. 开放式 3. 包含物业费\n");
  console.log("  输入你的回答（输入空白行提交，输入 skip 跳过本轮）：\n");

  while (answered.length + skipped.length < questions.length) {
    round++;

    // 获取本轮待回答的问题
    const remaining = getRemainingQuestions(questions, answered, skipped);
    if (remaining.length === 0) break;

    const roundQuestions = remaining.slice(0, maxPerRound);
    displayRoundQuestions(roundQuestions, questions, showCategory, answered.length, questions.length);

    // 读取用户输入
    const raw = await readMultilineInput();
    if (!raw.trim()) continue; // 空输入，重来
    if (raw.trim().toLowerCase() === "skip") {
      for (const q of roundQuestions) {
        skipped.push(q.id);
      }
      console.log(`  ⏭️ 跳过本轮 ${roundQuestions.length} 个问题`);
      continue;
    }

    // 解析回答
    const result = parseAnswers({ raw }, roundQuestions);
    console.log(formatParseResult(result, roundQuestions));

    // 记录回答
    for (const a of result.answers) {
      answered.push({
        questionId: a.questionId,
        question: roundQuestions[a.questionIndex].question,
        answer: a.answer,
        confidence: a.confidence >= 0.7 ? "high" : "low",
        skipped: false,
        answeredAt: new Date().toISOString(),
      });
    }

    // 未匹配的也算跳过（本轮）
    for (const q of roundQuestions) {
      if (
        !result.answers.some((a) => a.questionId === q.id) &&
        !skipped.includes(q.id) &&
        !answered.some((a) => a.questionId === q.id)
      ) {
        skipped.push(q.id);
      }
    }

    // 显示进度
    const progress = answered.length + skipped.length;
    console.log(`  📊 进度: ${progress}/${questions.length} (已回答 ${answered.length}, 已跳过 ${skipped.length})\n`);

    if (progress < questions.length) {
      console.log("  继续回答剩余问题，或输入 skip 跳过本轮：\n");
    }
  }

  console.log(`  ✅ 追问收集完成: ${answered.length} 个已回答, ${skipped.length} 个跳过, ${round} 轮\n`);

  return { answered, skipped, totalRounds: round };
}

// ───── 辅助函数 ─────

function getRemainingQuestions(
  all: QuestionSkeleton[],
  answered: AnsweredQuestion[],
  skipped: string[]
): QuestionSkeleton[] {
  const answeredIds = new Set(answered.map((a) => a.questionId));
  const skippedIds = new Set(skipped);
  return all.filter((q) => !answeredIds.has(q.id) && !skippedIds.has(q.id));
}

function displayRoundQuestions(
  roundQuestions: QuestionSkeleton[],
  allQuestions: QuestionSkeleton[],
  showCategory: boolean,
  answeredCount: number,
  totalCount: number
): void {
  console.log(`  ─── 第 ${answeredCount + 1}-${Math.min(answeredCount + roundQuestions.length, totalCount)} 问 ───\n`);
  for (const q of roundQuestions) {
    const idx = allQuestions.findIndex((aq) => aq.id === q.id);
    const num = idx >= 0 ? idx + 1 : "?";
    const cat = showCategory ? `[${q.category}]` : "";
    console.log(`  ${num}. ${cat} ${q.question}`);
  }
  console.log("");
}

async function readMultilineInput(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const lines: string[] = [];

  return new Promise((resolve) => {
    rl.question("> ", (line) => {
      if (line.trim()) {
        lines.push(line);
      } else {
        rl.close();
        resolve(lines.join("\n"));
        return;
      }

      // 继续读后续行
      const askNext = () => {
        rl.question("  ", (nextLine) => {
          if (nextLine.trim()) {
            lines.push(nextLine);
            askNext();
          } else {
            rl.close();
            resolve(lines.join("\n"));
          }
        });
      };
      askNext();
    });
  });
}
