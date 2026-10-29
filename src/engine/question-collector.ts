/**
 * 追问交互收集器。
 *
 * 关键修复：
 *   - 问题先落库，回答后更新；中断后可以恢复。
 *   - 本轮没答的问题不会被静默标记为跳过，而是下一轮继续问。
 *   - 用户显式输入 skip 才跳过；连续多轮无法解析时给出提示并允许退出。
 */

import type { AnsweredQuestion, QuestionSkeleton } from './types.js';
import { parseAnswers, formatParseResult } from './answer-parser.js';
import { getQA, updateQAAnswer } from '../storage/db.js';
import type { QARow } from '../storage/db.js';

export interface CollectorDeps {
  taskId: string;
  ask: (prompt: string) => Promise<string | null>;
  maxPerRound?: number;
  showCategory?: boolean;
  notify?: (message: string) => void;
}

export interface CollectorResult {
  answered: AnsweredQuestion[];
  skipped: string[];
  interrupted: boolean;
  totalRounds: number;
}

function rowMap(taskId: string): Map<number, QARow> {
  return new Map(getQA(taskId).map((row) => [row.id, row]));
}

function toAnswered(q: QuestionSkeleton, answer: string, confidence: 'high' | 'low'): AnsweredQuestion {
  return {
    questionId: q.id,
    question: q.question,
    answer,
    confidence,
    skipped: false,
    answeredAt: new Date().toISOString(),
  };
}

export async function collectAnswers(
  questions: QuestionSkeleton[],
  deps: CollectorDeps,
): Promise<CollectorResult> {
  const { taskId, ask } = deps;
  const maxPerRound = deps.maxPerRound ?? 8;
  const showCategory = deps.showCategory ?? true;
  const notify = deps.notify ?? ((message: string) => console.log(message));

  const answered: AnsweredQuestion[] = [];
  const skipped: string[] = [];
  let totalRounds = 0;
  let unmatchedRounds = 0;

  if (questions.length === 0) {
    return { answered, skipped, interrupted: false, totalRounds };
  }

  notify(`\n  📋 需要你确认 ${questions.length} 个问题。`);
  notify('  可以一次回答多个，格式：1. 答案 2. 答案；输入 skip 跳过本批；quit 暂停任务。\n');

  while (true) {
    const rows = rowMap(taskId);
    const pending = questions.filter((q) => {
      const row = rows.get(Number(q.id));
      return row !== undefined && row.answer === null && row.skipped === 0;
    });

    if (pending.length === 0) break;

    totalRounds++;
    const batch = pending.slice(0, maxPerRound);

    notify(`  ─── 第 ${totalRounds} 批（剩余 ${pending.length} 个）───`);
    batch.forEach((q, index) => {
      const category = showCategory ? `[${q.category}] ` : '';
      notify(`  ${index + 1}. ${category}${q.question}`);
    });
    notify('');

    const raw = await ask('> ');
    if (raw === null) {
      return { answered, skipped, interrupted: true, totalRounds };
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      notify('  ⚠️ 输入为空，请重新回答。');
      continue;
    }

    if (trimmed.toLowerCase() === 'skip' || trimmed === '/skip') {
      for (const q of batch) {
        updateQAAnswer(Number(q.id), '', true);
        skipped.push(q.id);
      }
      notify(`  ⏭️ 已跳过本批 ${batch.length} 个问题。\n`);
      continue;
    }

    if (['quit', 'exit', '/quit', '/exit', '/pause'].includes(trimmed.toLowerCase())) {
      return { answered, skipped, interrupted: true, totalRounds };
    }

    const parsed = parseAnswers({ raw }, batch);
    notify(formatParseResult(parsed, batch));

    let matched = 0;
    for (const a of parsed.answers) {
      const q = batch[a.questionIndex];
      if (!q) continue;

      if (!a.answer.trim()) {
        updateQAAnswer(Number(q.id), '', true);
        skipped.push(q.id);
        continue;
      }

      const confidence: 'high' | 'low' = a.confidence >= 0.7 ? 'high' : 'low';
      updateQAAnswer(Number(q.id), a.answer, false);
      answered.push(toAnswered(q, a.answer, confidence));
      matched++;
    }

    if (matched === 0) {
      unmatchedRounds++;
      notify('  ⚠️ 没有匹配到任何问题。请使用序号格式，或输入 skip 跳过本批。\n');
      if (unmatchedRounds >= 3) {
        for (const q of batch) {
          updateQAAnswer(Number(q.id), '', true);
          skipped.push(q.id);
        }
        notify('  ⏭️ 连续 3 轮无法解析，已跳过本批问题。\n');
      }
    } else {
      unmatchedRounds = 0;
    }
  }

  notify(`  ✅ 本轮问答完成：${answered.length} 个已回答，${skipped.length} 个跳过。\n`);
  return { answered, skipped, interrupted: false, totalRounds };
}
