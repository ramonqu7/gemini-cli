/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { LoopType } from '../telemetry/types.js';
import type { LoopDetectionResult } from './loopDetectionService.js';

/**
 * Maximum number of recovery attempts before aborting the agent loop.
 * After this many failed recoveries, the loop is considered unrecoverable.
 */
const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * Describes the kind of loop pattern detected, used to select the
 * most appropriate recovery message.
 */
export enum LoopPattern {
  /** The same tool was called with identical arguments repeatedly. */
  SAME_TOOL_SAME_ARGS = 'same_tool_same_args',
  /** The model is repeating the same text content in a loop. */
  CONTENT_CHANTING = 'content_chanting',
  /** An LLM-based analysis determined the model is stuck. */
  LLM_DETECTED = 'llm_detected',
  /** Catch-all for loops that don't match a specific pattern. */
  GENERAL = 'general',
}

/**
 * Service that generates targeted recovery messages when a loop is detected
 * and tracks recovery attempts. When a loop is detected, instead of
 * immediately stopping the agent, this service provides a directive message
 * that is injected as a user-role message to help the model break out of the
 * loop. After {@link MAX_RECOVERY_ATTEMPTS} failed recoveries, the service
 * signals that the agent should abort.
 */
export class LoopRecoveryService {
  private recoveryAttempts = 0;
  private readonly maxRecoveryAttempts: number;

  constructor(maxRecoveryAttempts: number = MAX_RECOVERY_ATTEMPTS) {
    this.maxRecoveryAttempts = maxRecoveryAttempts;
  }

  /**
   * Classifies a {@link LoopDetectionResult} into a {@link LoopPattern}
   * for selecting the right recovery message.
   */
  classifyLoop(loopResult: LoopDetectionResult): LoopPattern {
    if (!loopResult.type) {
      return LoopPattern.GENERAL;
    }

    switch (loopResult.type) {
      case LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS:
        return LoopPattern.SAME_TOOL_SAME_ARGS;

      case LoopType.CHANTING_IDENTICAL_SENTENCES:
      case LoopType.CONTENT_CHANTING_LOOP:
        return LoopPattern.CONTENT_CHANTING;

      case LoopType.LLM_DETECTED_LOOP:
        return LoopPattern.LLM_DETECTED;

      default:
        return LoopPattern.GENERAL;
    }
  }

  /**
   * Generates a recovery message tailored to the detected loop pattern.
   * The message is designed to be injected as a user-role message so the
   * model treats it as an instruction.
   *
   * @param loopResult - The detection result from {@link LoopDetectionService}.
   * @returns A directive string to inject into the conversation.
   */
  getRecoveryMessage(loopResult: LoopDetectionResult): string {
    const pattern = this.classifyLoop(loopResult);
    const attempt = this.recoveryAttempts + 1;
    const detail = loopResult.detail ?? 'Repetitive patterns identified';

    switch (pattern) {
      case LoopPattern.SAME_TOOL_SAME_ARGS:
        return (
          `System: Loop recovery (attempt ${attempt}/${this.maxRecoveryAttempts}). ` +
          `You are repeating the same tool call with identical arguments. ` +
          `Details: ${detail}. ` +
          `The previous attempts produced the same result. ` +
          `Try a different approach: use different arguments, read the relevant file first to understand the current state, or ask the user for clarification. ` +
          `Do NOT repeat the same tool call again.`
        );

      case LoopPattern.CONTENT_CHANTING:
        return (
          `System: Loop recovery (attempt ${attempt}/${this.maxRecoveryAttempts}). ` +
          `You are repeating the same text content in a loop. ` +
          `Details: ${detail}. ` +
          `Stop generating repetitive text. Instead, take a concrete action: ` +
          `call a tool to make progress, present your final answer, or ask the user what to do next.`
        );

      case LoopPattern.LLM_DETECTED:
        return (
          `System: Loop recovery (attempt ${attempt}/${this.maxRecoveryAttempts}). ` +
          `Analysis indicates you are stuck in an unproductive loop. ` +
          `Details: ${detail}. ` +
          `Before your next action, explain what you have tried so far, why it has not worked, ` +
          `and describe a fundamentally different approach you will take now. ` +
          `Do not repeat any of the actions you have already attempted.`
        );

      case LoopPattern.GENERAL:
      default:
        return (
          `System: Loop recovery (attempt ${attempt}/${this.maxRecoveryAttempts}). ` +
          `You appear to be stuck in a loop. ` +
          `Details: ${detail}. ` +
          `Before your next action, step back and reconsider your approach. ` +
          `What is the actual goal? What have you tried? Why hasn't it worked? ` +
          `Take a fundamentally different approach. Do not repeat previous actions.`
        );
    }
  }

  /**
   * Records a recovery attempt and returns the recovery message.
   * This should be called each time a loop is detected and recovery
   * is attempted.
   *
   * @param loopResult - The detection result from {@link LoopDetectionService}.
   * @returns The recovery message to inject, or null if max attempts exceeded.
   */
  attemptRecovery(loopResult: LoopDetectionResult): string | null {
    if (this.shouldAbort()) {
      return null;
    }
    const message = this.getRecoveryMessage(loopResult);
    this.recoveryAttempts++;
    return message;
  }

  /**
   * Returns true if the maximum number of recovery attempts has been reached.
   * When this returns true, the agent loop should be stopped entirely.
   */
  shouldAbort(): boolean {
    return this.recoveryAttempts >= this.maxRecoveryAttempts;
  }

  /**
   * Returns the current number of recovery attempts made.
   */
  getRecoveryAttempts(): number {
    return this.recoveryAttempts;
  }

  /**
   * Resets the recovery attempt counter. This should be called when a new
   * user prompt is received, since the new prompt represents a fresh task.
   */
  reset(): void {
    this.recoveryAttempts = 0;
  }
}
