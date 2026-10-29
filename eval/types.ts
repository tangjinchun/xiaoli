/**
 * 离线测评任务定义。
 */

import type { PlanDecision, QuestionSkeleton, TaskStatus } from '../src/engine/types.js';
import type { RawPlan } from '../src/engine/plan-compiler.js';

export interface EvalRefinement {
  questions: QuestionSkeleton[];
  remaining_gaps?: number;
  can_terminate?: boolean;
  reasons?: string[];
}

export interface EvalTask {
  id: string;
  name: string;
  description: string;
  files?: Record<string, string>;
  questions: QuestionSkeleton[];
  plan: RawPlan;
  refinement?: EvalRefinement;
  /** 每次 ask() 依次消费一个回答；格式建议 "1. ... 2. ..." */
  answers: string[];
  /** ask_user 工具的回答队列 */
  askUserAnswers?: string[];
  planDecision?: PlanDecision;
  dangerousConfirm?: boolean;
  /** 总轮数（含初始问答）；默认 1，表示不做追加追问 */
  maxRefinementRounds?: number;
  /** 完成 N 个步骤后模拟 Ctrl+C 暂停 */
  stopAfterStep?: number;
  /** 暂停后自动 continue，并期望最终完成 */
  resumeAfterStop?: boolean;
  /** 需要创建的 cwd 外文件（用于验证危险命令被拦截） */
  outsideFile?: boolean;
  expected: {
    status: TaskStatus;
    files?: Record<string, string>;
    fileAbsent?: string[];
    errorContains?: string;
    qaMin?: number;
    sawRetry?: boolean;
    firstRunStatus?: TaskStatus;
  };
}
