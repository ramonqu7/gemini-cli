/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { HarnessBudgetConfig, parseDuration } from './harnessConfig.js';

/**
 * Graduated budget consumption levels.
 */
export type BudgetLevel = 'ok' | 'warning' | 'checkpoint' | 'exceeded';

/**
 * Snapshot of budget consumption at a point in time.
 */
export interface BudgetStatus {
  turnsUsed: number;
  turnsMax: number;
  elapsedMs: number;
  maxDurationMs: number;
  level: BudgetLevel;
  turnPercent: number;
  timePercent: number;
}

/**
 * Tracks turn and wall-clock consumption against a budget and emits
 * graduated warnings as thresholds are crossed.
 */
export class BudgetEnforcerService {
  private turnsUsed = 0;
  private startTime: number;
  private readonly maxTurns: number;
  private readonly maxDurationMs: number;
  private readonly warningThreshold: number;
  private readonly checkpointThreshold: number;

  constructor(config: HarnessBudgetConfig) {
    this.maxTurns = config.maxTurns;
    const parsed = parseDuration(config.maxDuration);
    if (parsed === null) {
      throw new Error(`Invalid duration: ${config.maxDuration}`);
    }
    this.maxDurationMs = parsed;
    this.warningThreshold = config.warningThreshold;
    this.checkpointThreshold = config.checkpointThreshold;
    this.startTime = Date.now();
  }

  /** Increment the turn counter by one. */
  recordTurn(): void {
    this.turnsUsed++;
  }

  /** Compute the current budget status. */
  getStatus(): BudgetStatus {
    const elapsedMs = Date.now() - this.startTime;
    const turnPercent = this.turnsUsed / this.maxTurns;
    const timePercent = elapsedMs / this.maxDurationMs;
    const level = this.computeLevel(Math.max(turnPercent, timePercent));

    return {
      turnsUsed: this.turnsUsed,
      turnsMax: this.maxTurns,
      elapsedMs,
      maxDurationMs: this.maxDurationMs,
      level,
      turnPercent,
      timePercent,
    };
  }

  /**
   * Return a human-readable warning message when the budget level is above
   * 'ok', or null when everything is fine.
   */
  getWarningMessage(): string | null {
    const status = this.getStatus();
    const pct = Math.round(Math.max(status.turnPercent, status.timePercent) * 100);
    const turns = `${status.turnsUsed}/${status.turnsMax} turns`;

    switch (status.level) {
      case 'ok':
        return null;
      case 'warning':
        return `Budget warning: ${pct}% consumed (${turns}). Plan to wrap up.`;
      case 'checkpoint':
        return `Budget critical: ${pct}% consumed (${turns}). Pausing for review.`;
      case 'exceeded':
        return `Budget exceeded: ${pct}% consumed (${turns}). Summarize state and stop.`;
      default:
        return null;
    }
  }

  /** True when the level is 'checkpoint' — the caller should pause. */
  shouldPause(): boolean {
    return this.getStatus().level === 'checkpoint';
  }

  /** True when the level is 'exceeded' — the caller should stop. */
  shouldStop(): boolean {
    return this.getStatus().level === 'exceeded';
  }

  /** Reset turn count and start time. */
  reset(): void {
    this.turnsUsed = 0;
    this.startTime = Date.now();
  }

  // ── private ──────────────────────────────────────────────────────────

  private computeLevel(percent: number): BudgetLevel {
    if (percent >= 1.0) return 'exceeded';
    if (percent >= this.checkpointThreshold) return 'checkpoint';
    if (percent >= this.warningThreshold) return 'warning';
    return 'ok';
  }
}
