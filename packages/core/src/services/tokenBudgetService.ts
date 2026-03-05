/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentResponseUsageMetadata} from '@google/genai';

/**
 * Context utilization status levels.
 */
export type ContextStatus = 'low' | 'medium' | 'high' | 'critical';

/**
 * Snapshot of cumulative token usage for the session.
 */
export interface TokenUsageSnapshot {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalThoughtsTokens: number;
  totalTokens: number;
  apiCallCount: number;
}

/**
 * Rough per-token pricing (USD) by model family.
 * These are approximate and may lag behind actual pricing.
 */
interface ModelPricing {
  inputPerToken: number;
  outputPerToken: number;
  cachedInputPerToken: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'gemini-2.5-pro': {
    inputPerToken: 1.25e-6,
    outputPerToken: 10e-6,
    cachedInputPerToken: 0.3125e-6,
  },
  'gemini-2.5-flash': {
    inputPerToken: 0.15e-6,
    outputPerToken: 0.6e-6,
    cachedInputPerToken: 0.0375e-6,
  },
  'gemini-2.5-flash-lite': {
    inputPerToken: 0.075e-6,
    outputPerToken: 0.3e-6,
    cachedInputPerToken: 0.01875e-6,
  },
  default: {
    inputPerToken: 0.15e-6,
    outputPerToken: 0.6e-6,
    cachedInputPerToken: 0.0375e-6,
  },
};

/**
 * Service that tracks cumulative token usage and context window utilization
 * across an entire conversation session.
 *
 * This is a passive tracking service — it records data from API responses
 * and provides formatted summaries on demand. It does not modify the
 * streaming or rendering pipeline.
 */
export class TokenBudgetService {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCachedTokens = 0;
  private totalThoughtsTokens = 0;
  private apiCallCount = 0;

  private contextLimit = 1_048_576; // default 1M
  private currentContextSize = 0;

  private enabled = false;
  private modelFamily = 'default';

  // ─── Lifecycle ───────────────────────────────────────────────

  /**
   * Enable or disable tracking. Disabled by default.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Reset all counters (e.g., on chat reset).
   */
  reset(): void {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCachedTokens = 0;
    this.totalThoughtsTokens = 0;
    this.apiCallCount = 0;
    this.currentContextSize = 0;
  }

  // ─── Recording ───────────────────────────────────────────────

  /**
   * Record token usage from an API response's usageMetadata.
   * Should be called after each API response chunk that contains
   * usageMetadata (typically the final chunk).
   */
  recordApiResponse(usageMetadata: GenerateContentResponseUsageMetadata): void {
    if (!this.enabled) return;

    const input = usageMetadata.promptTokenCount ?? 0;
    const output = usageMetadata.candidatesTokenCount ?? 0;
    const cached = usageMetadata.cachedContentTokenCount ?? 0;
    const thoughts = usageMetadata.thoughtsTokenCount ?? 0;

    this.totalInputTokens += input;
    this.totalOutputTokens += output;
    this.totalCachedTokens += cached;
    this.totalThoughtsTokens += thoughts;
    this.apiCallCount++;

    // Update current context size from the prompt token count
    // (this reflects the actual context window usage as reported by the API)
    if (input > 0) {
      this.currentContextSize = input;
    }
  }

  /**
   * Record token counts from raw numbers (for cases where usageMetadata
   * is not directly available).
   */
  recordTokenCounts(
    inputTokens: number,
    outputTokens: number,
    cachedTokens: number = 0,
    thoughtsTokens: number = 0,
  ): void {
    if (!this.enabled) return;

    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCachedTokens += cachedTokens;
    this.totalThoughtsTokens += thoughtsTokens;
    this.apiCallCount++;

    if (inputTokens > 0) {
      this.currentContextSize = inputTokens;
    }
  }

  // ─── Context Window ──────────────────────────────────────────

  /**
   * Set the context window limit from model configuration.
   */
  setContextLimit(limit: number): void {
    this.contextLimit = limit;
  }

  /**
   * Update the current context size (e.g., from lastPromptTokenCount).
   */
  updateCurrentContextSize(size: number): void {
    this.currentContextSize = size;
  }

  /**
   * Get the context utilization ratio (0.0 to 1.0).
   */
  getContextUtilization(): number {
    if (this.contextLimit <= 0) return 0;
    return Math.min(this.currentContextSize / this.contextLimit, 1.0);
  }

  /**
   * Get the context status category.
   */
  getContextStatus(): ContextStatus {
    const utilization = this.getContextUtilization();
    if (utilization >= 0.9) return 'critical';
    if (utilization >= 0.75) return 'high';
    if (utilization >= 0.5) return 'medium';
    return 'low';
  }

  getContextLimit(): number {
    return this.contextLimit;
  }

  getCurrentContextSize(): number {
    return this.currentContextSize;
  }

  // ─── Cumulative Getters ──────────────────────────────────────

  getTotalInputTokens(): number {
    return this.totalInputTokens;
  }

  getTotalOutputTokens(): number {
    return this.totalOutputTokens;
  }

  getTotalCachedTokens(): number {
    return this.totalCachedTokens;
  }

  getTotalThoughtsTokens(): number {
    return this.totalThoughtsTokens;
  }

  getTotalTokens(): number {
    return this.totalInputTokens + this.totalOutputTokens;
  }

  getApiCallCount(): number {
    return this.apiCallCount;
  }

  getUsageSnapshot(): TokenUsageSnapshot {
    return {
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCachedTokens: this.totalCachedTokens,
      totalThoughtsTokens: this.totalThoughtsTokens,
      totalTokens: this.getTotalTokens(),
      apiCallCount: this.apiCallCount,
    };
  }

  // ─── Cost Estimation ─────────────────────────────────────────

  /**
   * Set the model family for cost estimation.
   * Accepts a model ID string; extracts the family prefix for pricing lookup.
   */
  setModelFamily(modelId: string): void {
    // Try exact match first, then prefix-based matching
    if (MODEL_PRICING[modelId]) {
      this.modelFamily = modelId;
      return;
    }
    for (const key of Object.keys(MODEL_PRICING)) {
      if (key !== 'default' && modelId.startsWith(key)) {
        this.modelFamily = key;
        return;
      }
    }
    this.modelFamily = 'default';
  }

  /**
   * Estimate the session cost in USD based on cumulative token usage.
   * This is a rough estimate using hardcoded per-token rates.
   */
  getSessionCost(): number {
    const pricing = MODEL_PRICING[this.modelFamily] ?? MODEL_PRICING['default'];

    // Cached tokens are charged at the cached rate instead of the input rate
    const nonCachedInput = Math.max(
      0,
      this.totalInputTokens - this.totalCachedTokens,
    );
    const cost =
      nonCachedInput * pricing.inputPerToken +
      this.totalCachedTokens * pricing.cachedInputPerToken +
      this.totalOutputTokens * pricing.outputPerToken;

    return cost;
  }

  // ─── Formatting ──────────────────────────────────────────────

  /**
   * Format a compact one-line budget summary.
   * Example: "Tokens: 45.2k/1M (4.5%) | Cost: ~$0.03"
   */
  formatBudgetSummary(): string {
    const contextTokens = this.currentContextSize;
    const limit = this.contextLimit;
    const pct = (this.getContextUtilization() * 100).toFixed(1);
    const cost = this.getSessionCost();

    return `Tokens: ${formatTokenCount(contextTokens)}/${formatTokenCount(limit)} (${pct}%) | Cost: ~$${cost.toFixed(2)}`;
  }

  /**
   * Format a detailed multi-line budget breakdown.
   */
  formatDetailedBudget(): string {
    const lines = [
      `Session Token Usage (${this.apiCallCount} API calls):`,
      `  Input:    ${formatTokenCount(this.totalInputTokens)}`,
      `  Output:   ${formatTokenCount(this.totalOutputTokens)}`,
      `  Cached:   ${formatTokenCount(this.totalCachedTokens)}`,
      `  Thoughts: ${formatTokenCount(this.totalThoughtsTokens)}`,
      `  Total:    ${formatTokenCount(this.getTotalTokens())}`,
      ``,
      `Context Window:`,
      `  Used:     ${formatTokenCount(this.currentContextSize)} / ${formatTokenCount(this.contextLimit)} (${(this.getContextUtilization() * 100).toFixed(1)}%)`,
      `  Status:   ${this.getContextStatus()}`,
      ``,
      `Estimated Cost: ~$${this.getSessionCost().toFixed(4)}`,
    ];
    return lines.join('\n');
  }

  /**
   * Generate a visual progress bar for context utilization.
   * @param width - Character width of the bar (default 20).
   */
  getProgressBar(width: number = 20): string {
    const utilization = this.getContextUtilization();
    const filled = Math.round(utilization * width);
    const empty = width - filled;
    const pct = (utilization * 100).toFixed(0);

    const filledChar = '\u2588'; // full block
    const emptyChar = '\u2591'; // light shade

    return `${filledChar.repeat(filled)}${emptyChar.repeat(empty)} ${pct}%`;
  }
}

/**
 * Format a token count into a human-readable string.
 * Examples: 1500 -> "1.5k", 1048576 -> "1M", 250 -> "250"
 */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    const m = count / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const k = count / 1_000;
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return `${count}`;
}

/**
 * Singleton instance for convenience. Consumers may also instantiate
 * their own TokenBudgetService if needed.
 */
export const tokenBudgetService = new TokenBudgetService();
