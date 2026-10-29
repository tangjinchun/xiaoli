import { describe, expect, it } from 'vitest';
import { parseAnswers, formatParseResult } from '../../src/engine/answer-parser.js';
import type { QuestionSkeleton } from '../../src/engine/types.js';

function questions(count: number): QuestionSkeleton[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `q-${i + 1}`,
    question: `问题 ${i + 1}`,
    category: '测试',
    expectedAnswerType: 'short',
    priority: 'high',
  }));
}

describe('回答解析器', () => {
  it('支持一行多个序号', () => {
    const result = parseAnswers({ raw: '1. 甲 2. 乙' }, questions(2));
    expect(result.answers).toHaveLength(2);
    expect(result.answers[0].answer).toBe('甲');
    expect(result.answers[1].answer).toBe('乙');
    expect(result.coveragePercent).toBe(100);
  });

  it('支持多行序号和多行回答', () => {
    const result = parseAnswers(
      { raw: '1. 第一行\n第二行\n2. 乙' },
      questions(2),
    );
    expect(result.answers).toHaveLength(2);
    expect(result.answers[0].answer).toContain('第二行');
  });

  it('支持中文分隔符', () => {
    const result = parseAnswers({ raw: '1、甲 2、乙' }, questions(2));
    expect(result.answers).toHaveLength(2);
  });

  it('不把小数误判成序号', () => {
    const result = parseAnswers(
      { raw: '1. 响应时间从 8.0 秒降到 2.0 秒' },
      questions(1),
    );
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].answer).toContain('8.0');
  });

  it('纯文本退化为关键词匹配', () => {
    const qs: QuestionSkeleton[] = [
      {
        id: 'q-1',
        question: '用哪个数据库？',
        category: '环境约束',
        expectedAnswerType: 'short',
        priority: 'high',
      },
    ];
    const result = parseAnswers({ raw: '数据库用 MySQL 8.0' }, qs);
    expect(result.answers).toHaveLength(1);
  });

  it('空输入返回空结果', () => {
    const result = parseAnswers({ raw: '   ' }, questions(2));
    expect(result.answers).toHaveLength(0);
    expect(result.coveragePercent).toBe(0);
  });

  it('格式化结果包含匹配率', () => {
    const qs = questions(2);
    const result = parseAnswers({ raw: '1. 甲 2. 乙' }, qs);
    expect(formatParseResult(result, qs)).toContain('匹配率');
  });
});
