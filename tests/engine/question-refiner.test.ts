import { describe, expect, it } from 'vitest';
import {
  canTerminate,
  detectGaps,
  generateRefinementQuestions,
  gradientDecay,
} from '../../src/engine/question-refiner.js';
import type { AnsweredQuestion, QuestionSkeleton } from '../../src/engine/types.js';

function answered(answer: string): AnsweredQuestion {
  return {
    questionId: 'q-1',
    question: '目标是什么？',
    answer,
    confidence: 'high',
    skipped: false,
    answeredAt: new Date().toISOString(),
  };
}

const previous: QuestionSkeleton[] = [
  {
    id: 'q-1',
    question: '目标是什么？',
    category: '目标定义',
    expectedAnswerType: 'short',
    priority: 'high',
  },
];

describe('追问收束', () => {
  it('梯度递减且最少 1 个', () => {
    expect(gradientDecay(8)).toBe(4);
    expect(gradientDecay(4)).toBe(2);
    expect(gradientDecay(1)).toBe(1);
  });

  it('零缺口终止', () => {
    expect(canTerminate(0, 1, [])).toBe(true);
  });

  it('达到轮数上限终止', () => {
    expect(canTerminate(2, 3, [3, 2], { maxRounds: 3 })).toBe(true);
  });

  it('连续缺口数不下降时终止', () => {
    expect(canTerminate(2, 1, [2], { maxRounds: 3 })).toBe(true);
  });

  it('有缺口且未收敛时继续', () => {
    expect(canTerminate(2, 1, [], { maxRounds: 3 })).toBe(false);
  });

  it('检测模糊回答的缺口', () => {
    const gaps = detectGaps([answered('做个文件，越快越好')], previous);
    expect(gaps.size).toBeGreaterThan(0);
    expect(gaps.has('成功标准') || gaps.has('时间线')).toBe(true);
  });

  it('无 AI 时生成启发式追问', async () => {
    const result = await generateRefinementQuestions(
      [answered('做个文件，越快越好')],
      previous,
      { round: 1 },
      { useAI: false, maxRounds: 3 },
    );
    expect(result.canTerminate).toBe(false);
    expect(result.newQuestions.length).toBeGreaterThan(0);
    expect(result.remainingGaps).toBeGreaterThan(0);
  });
});
