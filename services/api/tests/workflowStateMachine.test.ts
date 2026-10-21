import { describe, it, expect } from 'vitest';
import {
  validateTaskTransition,
  validateRunTransition,
  isTaskCancellable,
} from '../src/services/workflowStateMachine.js';

describe('Workflow State Machine Transition Validation', () => {
  it('allows valid task state transitions', () => {
    // QUEUED -> RUNNING
    expect(() => validateTaskTransition('QUEUED', 'RUNNING')).not.toThrow();
    // QUEUED -> CANCELLED
    expect(() => validateTaskTransition('QUEUED', 'CANCELLED')).not.toThrow();
    // QUEUED -> CANCEL_REQUESTED
    expect(() => validateTaskTransition('QUEUED', 'CANCEL_REQUESTED')).not.toThrow();
    // RUNNING -> COMPLETED
    expect(() => validateTaskTransition('RUNNING', 'COMPLETED')).not.toThrow();
    // RUNNING -> FAILED
    expect(() => validateTaskTransition('RUNNING', 'FAILED')).not.toThrow();
    // CANCEL_REQUESTED -> CANCELLED
    expect(() => validateTaskTransition('CANCEL_REQUESTED', 'CANCELLED')).not.toThrow();
    // Identical transition is a no-op
    expect(() => validateTaskTransition('RUNNING', 'RUNNING')).not.toThrow();
  });

  it('rejects illegal task state transitions', () => {
    // Terminal COMPLETED cannot transition to RUNNING or QUEUED
    expect(() => validateTaskTransition('COMPLETED', 'RUNNING')).toThrow(/Illegal task state transition/);
    expect(() => validateTaskTransition('COMPLETED', 'QUEUED')).toThrow(/Illegal task state transition/);

    // Terminal CANCELLED cannot transition to RUNNING
    expect(() => validateTaskTransition('CANCELLED', 'RUNNING')).toThrow(/Illegal task state transition/);

    // Terminal FAILED cannot transition back to RUNNING
    expect(() => validateTaskTransition('FAILED', 'RUNNING')).toThrow(/Illegal task state transition/);

    // QUEUED cannot jump directly to COMPLETED without RUNNING
    expect(() => validateTaskTransition('QUEUED', 'COMPLETED')).toThrow(/Illegal task state transition/);
  });

  it('allows valid workflow run transitions', () => {
    expect(() => validateRunTransition('QUEUED', 'RUNNING')).not.toThrow();
    expect(() => validateRunTransition('RUNNING', 'COMPLETED')).not.toThrow();
    expect(() => validateRunTransition('RUNNING', 'FAILED')).not.toThrow();
    expect(() => validateRunTransition('RUNNING', 'CANCELLED')).not.toThrow();
  });

  it('rejects illegal workflow run transitions', () => {
    expect(() => validateRunTransition('COMPLETED', 'RUNNING')).toThrow(/Illegal workflow run state transition/);
    expect(() => validateRunTransition('FAILED', 'QUEUED')).toThrow(/Illegal workflow run state transition/);
  });

  it('correctly classifies cancellable task statuses', () => {
    expect(isTaskCancellable('QUEUED')).toBe(true);
    expect(isTaskCancellable('RUNNING')).toBe(true);
    expect(isTaskCancellable('NEEDS_ATTENTION')).toBe(true);
    expect(isTaskCancellable('COMPLETED')).toBe(false);
    expect(isTaskCancellable('FAILED')).toBe(false);
    expect(isTaskCancellable('CANCELLED')).toBe(false);
  });
});
