/**
 * 引擎层可识别的异常。
 *
 * 这些异常不是“程序 bug”，而是正常的控制流：
 * 用户暂停、用户拒绝计划、安全策略拒绝、计划不合法。
 */

export class TaskPausedError extends Error {
  constructor(message = '任务已暂停') {
    super(message);
    this.name = 'TaskPausedError';
  }
}

export class UserRejectedError extends Error {
  constructor(message = '用户拒绝了该操作') {
    super(message);
    this.name = 'UserRejectedError';
  }
}

export class PolicyDeniedError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = 'PolicyDeniedError';
  }
}

export class ConfirmationRequiredError extends Error {
  constructor(
    public readonly reason: string,
    message = `需要用户确认: ${reason}`,
  ) {
    super(message);
    this.name = 'ConfirmationRequiredError';
  }
}

export class PlanValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(issues.length > 0 ? `${message}: ${issues.join('; ')}` : message);
    this.name = 'PlanValidationError';
  }
}

export class ToolExecutionError extends Error {
  constructor(
    message: string,
    public readonly exitCode?: number,
    public readonly stdout = '',
    public readonly stderr = '',
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationError';
  }
}

export function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'AbortError' ||
    err.name === 'TaskPausedError' ||
    err.message.toLowerCase().includes('aborted')
  );
}
