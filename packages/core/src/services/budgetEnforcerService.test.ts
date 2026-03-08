/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { BudgetEnforcerService } from './budgetEnforcerService.js';
import { HarnessBudgetConfig } from './harnessConfig.js';

describe('BudgetEnforcerService', () => {
  const baseConfig: HarnessBudgetConfig = {
    maxTurns: 10,
    maxDuration: '1h',
    warningThreshold: 0.8,
    checkpointThreshold: 0.95,
  };

  let service: BudgetEnforcerService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new BudgetEnforcerService(baseConfig);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('should start with zero usage and level ok', () => {
      const status = service.getStatus();
      expect(status.turnsUsed).toBe(0);
      expect(status.turnsMax).toBe(10);
      expect(status.level).toBe('ok');
      expect(status.turnPercent).toBe(0);
    });

    it('should report maxDurationMs matching 1 hour', () => {
      const status = service.getStatus();
      expect(status.maxDurationMs).toBe(3600000);
    });
  });

  describe('recordTurn', () => {
    it('should increment the turn counter', () => {
      service.recordTurn();
      expect(service.getStatus().turnsUsed).toBe(1);

      service.recordTurn();
      service.recordTurn();
      expect(service.getStatus().turnsUsed).toBe(3);
    });
  });

  describe('level thresholds based on turns', () => {
    it('should be ok below warningThreshold', () => {
      for (let i = 0; i < 7; i++) service.recordTurn();
      expect(service.getStatus().level).toBe('ok');
    });

    it('should be warning at warningThreshold (80%)', () => {
      for (let i = 0; i < 8; i++) service.recordTurn();
      const status = service.getStatus();
      expect(status.turnPercent).toBe(0.8);
      expect(status.level).toBe('warning');
    });

    it('should be warning between warning and checkpoint thresholds', () => {
      for (let i = 0; i < 9; i++) service.recordTurn();
      expect(service.getStatus().level).toBe('warning');
    });

    it('should be exceeded at 100%', () => {
      for (let i = 0; i < 10; i++) service.recordTurn();
      expect(service.getStatus().level).toBe('exceeded');
    });
  });

  describe('level thresholds based on time', () => {
    it('should be warning when time crosses warningThreshold', () => {
      // Advance 80% of 1h = 48 minutes
      vi.advanceTimersByTime(48 * 60 * 1000);
      const status = service.getStatus();
      expect(status.level).toBe('warning');
    });

    it('should be checkpoint when time crosses checkpointThreshold', () => {
      // Advance 96% of 1h = 57.6 minutes
      vi.advanceTimersByTime(57.6 * 60 * 1000);
      const status = service.getStatus();
      expect(status.level).toBe('checkpoint');
    });

    it('should be exceeded when time reaches 100%', () => {
      vi.advanceTimersByTime(3600000);
      expect(service.getStatus().level).toBe('exceeded');
    });
  });

  describe('checkpoint level with larger maxTurns', () => {
    it('should reach checkpoint at 95% turns', () => {
      const svc = new BudgetEnforcerService({
        ...baseConfig,
        maxTurns: 20,
      });
      for (let i = 0; i < 19; i++) svc.recordTurn();
      expect(svc.getStatus().turnPercent).toBe(0.95);
      expect(svc.getStatus().level).toBe('checkpoint');
    });
  });

  describe('level uses max of turnPercent and timePercent', () => {
    it('should use time percent when it is higher', () => {
      // 0 turns → 0% turn usage; advance 50 min → ~83% time usage → warning
      vi.advanceTimersByTime(50 * 60 * 1000);
      const status = service.getStatus();
      expect(status.turnPercent).toBe(0);
      expect(status.level).toBe('warning');
    });
  });

  describe('getWarningMessage', () => {
    it('should return null when level is ok', () => {
      expect(service.getWarningMessage()).toBeNull();
    });

    it('should return warning message at warning level', () => {
      for (let i = 0; i < 8; i++) service.recordTurn();
      const msg = service.getWarningMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain('Budget warning');
      expect(msg).toContain('80%');
      expect(msg).toContain('8/10 turns');
      expect(msg).toContain('Plan to wrap up');
    });

    it('should return critical message at checkpoint level', () => {
      const svc = new BudgetEnforcerService({
        ...baseConfig,
        maxTurns: 20,
      });
      for (let i = 0; i < 19; i++) svc.recordTurn();
      const msg = svc.getWarningMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain('Budget critical');
      expect(msg).toContain('95%');
      expect(msg).toContain('Pausing for review');
    });

    it('should return exceeded message at exceeded level', () => {
      for (let i = 0; i < 10; i++) service.recordTurn();
      const msg = service.getWarningMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain('Budget exceeded');
      expect(msg).toContain('100%');
      expect(msg).toContain('Summarize state and stop');
    });
  });

  describe('shouldPause', () => {
    it('should return false when level is ok', () => {
      expect(service.shouldPause()).toBe(false);
    });

    it('should return false when level is warning', () => {
      for (let i = 0; i < 8; i++) service.recordTurn();
      expect(service.shouldPause()).toBe(false);
    });

    it('should return true when level is checkpoint', () => {
      const svc = new BudgetEnforcerService({
        ...baseConfig,
        maxTurns: 20,
      });
      for (let i = 0; i < 19; i++) svc.recordTurn();
      expect(svc.shouldPause()).toBe(true);
    });

    it('should return false when level is exceeded', () => {
      for (let i = 0; i < 10; i++) service.recordTurn();
      expect(service.shouldPause()).toBe(false);
    });
  });

  describe('shouldStop', () => {
    it('should return false when level is ok', () => {
      expect(service.shouldStop()).toBe(false);
    });

    it('should return false when level is warning', () => {
      for (let i = 0; i < 8; i++) service.recordTurn();
      expect(service.shouldStop()).toBe(false);
    });

    it('should return true when level is exceeded', () => {
      for (let i = 0; i < 10; i++) service.recordTurn();
      expect(service.shouldStop()).toBe(true);
    });
  });

  describe('reset', () => {
    it('should reset turn count and start time', () => {
      for (let i = 0; i < 8; i++) service.recordTurn();
      vi.advanceTimersByTime(50 * 60 * 1000);
      expect(service.getStatus().level).toBe('warning');

      service.reset();

      const status = service.getStatus();
      expect(status.turnsUsed).toBe(0);
      expect(status.level).toBe('ok');
      expect(status.elapsedMs).toBeLessThanOrEqual(1);
    });
  });

  describe('constructor validation', () => {
    it('should throw on invalid duration string', () => {
      expect(
        () =>
          new BudgetEnforcerService({
            ...baseConfig,
            maxDuration: 'invalid',
          })
      ).toThrow('Invalid duration');
    });
  });
});
