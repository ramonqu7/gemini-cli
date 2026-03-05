/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { tokenLimit } from '../core/tokenLimits.js';

/**
 * Thresholds at which the auto-compact service takes action.
 *
 * - `suggest`: When context utilization reaches this fraction, a suggestion
 *   message is emitted (e.g. "Consider using /compact").
 * - `autoCompact`: When context utilization reaches this fraction, compression
 *   is triggered automatically without user intervention.
 */
export interface AutoCompactThresholds {
  suggest: number;
  autoCompact: number;
}

export const DEFAULT_AUTO_COMPACT_THRESHOLDS: AutoCompactThresholds = {
  suggest: 0.7,
  autoCompact: 0.85,
};

export enum AutoCompactAction {
  /** No action needed — utilization is within acceptable limits. */
  NONE = 'none',
  /** Utilization is high; suggest the user run /compact. */
  SUGGEST = 'suggest',
  /** Utilization is very high; auto-trigger compression. */
  AUTO_COMPACT = 'auto_compact',
}

export interface AutoCompactResult {
  action: AutoCompactAction;
  utilization: number;
  message?: string;
}

/**
 * Monitors context window utilization and recommends or triggers compaction.
 *
 * Each threshold fires at most once per session to avoid spamming the user
 * or triggering repeated compressions.
 */
export class AutoCompactService {
  private hasSuggested = false;
  private hasAutoCompacted = false;
  private thresholds: AutoCompactThresholds;

  constructor(thresholds?: Partial<AutoCompactThresholds>) {
    this.thresholds = {
      ...DEFAULT_AUTO_COMPACT_THRESHOLDS,
      ...thresholds,
    };
  }

  /**
   * Evaluates the current context utilization and returns the appropriate action.
   *
   * @param promptTokenCount - The number of tokens currently used in the prompt.
   * @param model - The active model identifier (used to look up token limit).
   * @returns An {@link AutoCompactResult} describing what action to take.
   */
  evaluate(promptTokenCount: number, model: string): AutoCompactResult {
    const limit = tokenLimit(model);
    if (limit <= 0) {
      return { action: AutoCompactAction.NONE, utilization: 0 };
    }

    const utilization = promptTokenCount / limit;

    if (utilization >= this.thresholds.autoCompact && !this.hasAutoCompacted) {
      this.hasAutoCompacted = true;
      this.hasSuggested = true; // skip suggestion since we're auto-compacting
      return {
        action: AutoCompactAction.AUTO_COMPACT,
        utilization,
        message: `Context is at ${Math.round(utilization * 100)}% capacity. Auto-compacting to free up space.`,
      };
    }

    if (utilization >= this.thresholds.suggest && !this.hasSuggested) {
      this.hasSuggested = true;
      return {
        action: AutoCompactAction.SUGGEST,
        utilization,
        message: `Context is at ${Math.round(utilization * 100)}% capacity. Consider using /compact to free up space.`,
      };
    }

    return { action: AutoCompactAction.NONE, utilization };
  }

  /**
   * Resets the session state. Call this when a new session starts or after
   * a successful compression to allow re-triggering at the same thresholds.
   */
  reset(): void {
    this.hasSuggested = false;
    this.hasAutoCompacted = false;
  }
}
