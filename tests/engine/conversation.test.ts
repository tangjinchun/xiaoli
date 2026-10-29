import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition } from '../../src/engine/conversation.js';

describe('任务状态机', () => {
  it('允许正常迁移', () => {
    expect(canTransition('questioning', 'planning')).toBe(true);
    expect(canTransition('planning', 'plan_ready')).toBe(true);
    expect(canTransition('plan_ready', 'executing')).toBe(true);
    expect(canTransition('executing', 'paused')).toBe(true);
    expect(canTransition('paused', 'executing')).toBe(true);
    expect(canTransition('executing', 'completed')).toBe(true);
  });

  it('拒绝非法迁移', () => {
    expect(canTransition('completed', 'executing')).toBe(false);
    expect(canTransition('rejected', 'executing')).toBe(false);
    expect(() => assertTransition('completed', 'executing')).toThrow();
  });

  it('允许幂等迁移', () => {
    expect(canTransition('paused', 'paused')).toBe(true);
  });
});
