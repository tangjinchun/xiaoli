/**
 * 测评用 UserIO：回答和确认都来自脚本，不读 stdin。
 */

import type { ExecutionPlan, ExecutionStep, PlanDecision } from '../src/engine/types.js';
import type { UserIO } from '../src/engine/orchestrator.js';
import type { ProgressEvent } from '../src/engine/executor.js';
import type { EvalTask } from './types.js';

export interface EvalIOOptions {
  verbose?: boolean;
  stopAfterStep?: number;
}

export class EvalIO implements UserIO {
  readonly progress: ProgressEvent[] = [];
  readonly messages: string[] = [];
  private readonly answerQueue: string[];
  private readonly askUserQueue: string[];
  private completedSteps = 0;
  private readonly stopAfterStep?: number;
  private readonly verbose: boolean;

  constructor(private readonly task: EvalTask, options: EvalIOOptions = {}) {
    this.answerQueue = [...task.answers];
    this.askUserQueue = [...(task.askUserAnswers ?? [])];
    this.stopAfterStep = options.stopAfterStep;
    this.verbose = options.verbose ?? false;
  }

  async ask(_prompt: string): Promise<string | null> {
    const answer = this.answerQueue.shift();
    return answer === undefined ? null : answer;
  }

  async confirmPlan(_plan: ExecutionPlan): Promise<PlanDecision> {
    return this.task.planDecision ?? 'confirm';
  }

  async confirmDangerous(_step: ExecutionStep, _reason: string): Promise<boolean> {
    return this.task.dangerousConfirm ?? false;
  }

  async askUser(_step: ExecutionStep, _prompt: string): Promise<string | null> {
    const answer = this.askUserQueue.shift();
    return answer === undefined ? null : answer;
  }

  notify(message: string): void {
    this.messages.push(message);
    if (this.verbose) console.log(message);
  }

  onProgress(event: ProgressEvent): void {
    this.progress.push(event);
    if (event.type === 'step_complete') this.completedSteps++;
    if (this.verbose) console.log(event.message);
  }

  shouldStop(): boolean {
    return this.stopAfterStep !== undefined && this.completedSteps >= this.stopAfterStep;
  }
}
