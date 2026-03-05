/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, it, expect, beforeEach} from 'vitest';
import {TokenBudgetService} from './tokenBudgetService.js';
import type {GenerateContentResponseUsageMetadata} from '@google/genai';

describe('TokenBudgetService', () => {
  let service: TokenBudgetService;

  beforeEach(() => {
    service = new TokenBudgetService();
    service.setEnabled(true);
  });

  describe('recording', () => {
    it('should track cumulative token usage from API responses', () => {
      const metadata1: GenerateContentResponseUsageMetadata = {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        cachedContentTokenCount: 10,
        thoughtsTokenCount: 5,
      };
      const metadata2: GenerateContentResponseUsageMetadata = {
        promptTokenCount: 200,
        candidatesTokenCount: 80,
        cachedContentTokenCount: 20,
        thoughtsTokenCount: 15,
      };

      service.recordApiResponse(metadata1);
      service.recordApiResponse(metadata2);

      expect(service.getTotalInputTokens()).toBe(300);
      expect(service.getTotalOutputTokens()).toBe(130);
      expect(service.getTotalCachedTokens()).toBe(30);
      expect(service.getTotalThoughtsTokens()).toBe(20);
      expect(service.getTotalTokens()).toBe(430);
      expect(service.getApiCallCount()).toBe(2);
    });

    it('should not record when disabled', () => {
      service.setEnabled(false);

      service.recordApiResponse({
        promptTokenCount: 100,
        candidatesTokenCount: 50,
      });

      expect(service.getTotalInputTokens()).toBe(0);
      expect(service.getApiCallCount()).toBe(0);
    });

    it('should handle missing fields in usageMetadata', () => {
      service.recordApiResponse({});

      expect(service.getTotalInputTokens()).toBe(0);
      expect(service.getTotalOutputTokens()).toBe(0);
      expect(service.getApiCallCount()).toBe(1);
    });

    it('should record from raw token counts', () => {
      service.recordTokenCounts(500, 200, 50, 10);

      expect(service.getTotalInputTokens()).toBe(500);
      expect(service.getTotalOutputTokens()).toBe(200);
      expect(service.getTotalCachedTokens()).toBe(50);
      expect(service.getTotalThoughtsTokens()).toBe(10);
    });
  });

  describe('context window', () => {
    it('should compute utilization ratio', () => {
      service.setContextLimit(1_000_000);
      service.updateCurrentContextSize(500_000);

      expect(service.getContextUtilization()).toBe(0.5);
    });

    it('should cap utilization at 1.0', () => {
      service.setContextLimit(1000);
      service.updateCurrentContextSize(2000);

      expect(service.getContextUtilization()).toBe(1.0);
    });

    it('should return correct status for each threshold', () => {
      service.setContextLimit(1000);

      service.updateCurrentContextSize(400);
      expect(service.getContextStatus()).toBe('low');

      service.updateCurrentContextSize(600);
      expect(service.getContextStatus()).toBe('medium');

      service.updateCurrentContextSize(800);
      expect(service.getContextStatus()).toBe('high');

      service.updateCurrentContextSize(950);
      expect(service.getContextStatus()).toBe('critical');
    });

    it('should update context size from API response promptTokenCount', () => {
      service.setContextLimit(1_000_000);
      service.recordApiResponse({
        promptTokenCount: 250_000,
        candidatesTokenCount: 100,
      });

      expect(service.getCurrentContextSize()).toBe(250_000);
      expect(service.getContextUtilization()).toBe(0.25);
    });
  });

  describe('cost estimation', () => {
    it('should estimate cost for default model', () => {
      service.recordTokenCounts(10_000, 1_000, 0, 0);

      const cost = service.getSessionCost();
      expect(cost).toBeGreaterThan(0);
    });

    it('should apply cached pricing discount', () => {
      service.setModelFamily('gemini-2.5-pro');

      // All input cached
      service.recordTokenCounts(10_000, 0, 10_000, 0);
      const costAllCached = service.getSessionCost();

      service.reset();
      service.setEnabled(true);

      // No caching
      service.recordTokenCounts(10_000, 0, 0, 0);
      const costNoCaching = service.getSessionCost();

      expect(costAllCached).toBeLessThan(costNoCaching);
    });

    it('should match model family by prefix', () => {
      service.setModelFamily('gemini-2.5-pro-preview-0325');
      service.recordTokenCounts(1_000_000, 100_000, 0, 0);

      const cost = service.getSessionCost();
      // gemini-2.5-pro: input 1.25e-6, output 10e-6
      const expectedCost = 1_000_000 * 1.25e-6 + 100_000 * 10e-6;
      expect(cost).toBeCloseTo(expectedCost, 4);
    });
  });

  describe('formatting', () => {
    it('should format a compact summary', () => {
      service.setContextLimit(1_048_576);
      service.recordTokenCounts(45_200, 5_000, 1_000, 500);

      const summary = service.formatBudgetSummary();
      expect(summary).toContain('Tokens:');
      expect(summary).toContain('Cost:');
      expect(summary).toContain('%');
    });

    it('should format a detailed breakdown', () => {
      service.recordTokenCounts(10_000, 2_000, 500, 100);

      const detailed = service.formatDetailedBudget();
      expect(detailed).toContain('Input:');
      expect(detailed).toContain('Output:');
      expect(detailed).toContain('Cached:');
      expect(detailed).toContain('Thoughts:');
      expect(detailed).toContain('Context Window:');
      expect(detailed).toContain('Estimated Cost:');
    });

    it('should generate a progress bar', () => {
      service.setContextLimit(100);
      service.updateCurrentContextSize(42);

      const bar = service.getProgressBar(10);
      expect(bar).toContain('42%');
      // 4 filled + 6 empty blocks at width 10
      expect(bar).toMatch(/^.{10} 42%$/);
    });
  });

  describe('reset', () => {
    it('should clear all counters', () => {
      service.recordTokenCounts(1000, 500, 100, 50);
      service.updateCurrentContextSize(1000);

      service.reset();

      expect(service.getTotalInputTokens()).toBe(0);
      expect(service.getTotalOutputTokens()).toBe(0);
      expect(service.getTotalCachedTokens()).toBe(0);
      expect(service.getTotalThoughtsTokens()).toBe(0);
      expect(service.getApiCallCount()).toBe(0);
      expect(service.getCurrentContextSize()).toBe(0);
    });
  });

  describe('snapshot', () => {
    it('should return a complete usage snapshot', () => {
      service.recordTokenCounts(1000, 500, 100, 50);
      service.recordTokenCounts(2000, 300, 200, 100);

      const snapshot = service.getUsageSnapshot();
      expect(snapshot).toEqual({
        totalInputTokens: 3000,
        totalOutputTokens: 800,
        totalCachedTokens: 300,
        totalThoughtsTokens: 150,
        totalTokens: 3800,
        apiCallCount: 2,
      });
    });
  });
});
