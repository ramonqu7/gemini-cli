/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { LoopType } from '../telemetry/types.js';
import type { LoopDetectionResult } from './loopDetectionService.js';
import { LoopRecoveryService, LoopPattern } from './loopRecoveryService.js';

describe('LoopRecoveryService', () => {
  let service: LoopRecoveryService;

  beforeEach(() => {
    service = new LoopRecoveryService();
  });

  describe('classifyLoop', () => {
    it('should classify CONSECUTIVE_IDENTICAL_TOOL_CALLS as SAME_TOOL_SAME_ARGS', () => {
      const result: LoopDetectionResult = {
        count: 1,
        type: LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
      };
      expect(service.classifyLoop(result)).toBe(
        LoopPattern.SAME_TOOL_SAME_ARGS,
      );
    });

    it('should classify CHANTING_IDENTICAL_SENTENCES as CONTENT_CHANTING', () => {
      const result: LoopDetectionResult = {
        count: 1,
        type: LoopType.CHANTING_IDENTICAL_SENTENCES,
      };
      expect(service.classifyLoop(result)).toBe(LoopPattern.CONTENT_CHANTING);
    });

    it('should classify CONTENT_CHANTING_LOOP as CONTENT_CHANTING', () => {
      const result: LoopDetectionResult = {
        count: 1,
        type: LoopType.CONTENT_CHANTING_LOOP,
      };
      expect(service.classifyLoop(result)).toBe(LoopPattern.CONTENT_CHANTING);
    });

    it('should classify LLM_DETECTED_LOOP as LLM_DETECTED', () => {
      const result: LoopDetectionResult = {
        count: 1,
        type: LoopType.LLM_DETECTED_LOOP,
      };
      expect(service.classifyLoop(result)).toBe(LoopPattern.LLM_DETECTED);
    });

    it('should classify missing type as GENERAL', () => {
      const result: LoopDetectionResult = { count: 1 };
      expect(service.classifyLoop(result)).toBe(LoopPattern.GENERAL);
    });
  });

  describe('getRecoveryMessage', () => {
    it('should produce a message mentioning repeated tool call for SAME_TOOL_SAME_ARGS', () => {
      const result: LoopDetectionResult = {
        count: 1,
        type: LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
        detail: 'Repeated tool call: readFile with arguments {"path":"/foo"}',
      };
      const message = service.getRecoveryMessage(result);
      expect(message).toContain('repeating the same tool call');
      expect(message).toContain('readFile');
      expect(message).toContain('attempt 1/3');
    });

    it('should produce a message about text repetition for CONTENT_CHANTING', () => {
      const result: LoopDetectionResult = {
        count: 1,
        type: LoopType.CHANTING_IDENTICAL_SENTENCES,
        detail: 'Repeating content detected: "I will wait..."',
      };
      const message = service.getRecoveryMessage(result);
      expect(message).toContain('repeating the same text content');
      expect(message).toContain('I will wait');
    });

    it('should produce a message about unproductive loop for LLM_DETECTED', () => {
      const result: LoopDetectionResult = {
        count: 1,
        type: LoopType.LLM_DETECTED_LOOP,
        detail: 'Model is alternating between edit and build without progress',
      };
      const message = service.getRecoveryMessage(result);
      expect(message).toContain('stuck in an unproductive loop');
      expect(message).toContain('fundamentally different approach');
    });

    it('should produce a general message when type is missing', () => {
      const result: LoopDetectionResult = { count: 1 };
      const message = service.getRecoveryMessage(result);
      expect(message).toContain('stuck in a loop');
      expect(message).toContain('Repetitive patterns identified');
    });

    it('should include attempt count in the message', () => {
      const result: LoopDetectionResult = {
        count: 1,
        type: LoopType.CONSECUTIVE_IDENTICAL_TOOL_CALLS,
      };
      // First attempt
      service.attemptRecovery(result);
      // Second attempt — message should say attempt 2
      const message = service.getRecoveryMessage(result);
      expect(message).toContain('attempt 2/3');
    });
  });

  describe('attemptRecovery', () => {
    it('should return a message on first attempt', () => {
      const result: LoopDetectionResult = { count: 1 };
      const message = service.attemptRecovery(result);
      expect(message).not.toBeNull();
      expect(message).toContain('attempt 1/3');
    });

    it('should return messages for up to maxRecoveryAttempts', () => {
      const result: LoopDetectionResult = { count: 1 };
      expect(service.attemptRecovery(result)).not.toBeNull();
      expect(service.attemptRecovery(result)).not.toBeNull();
      expect(service.attemptRecovery(result)).not.toBeNull();
    });

    it('should return null after maxRecoveryAttempts', () => {
      const result: LoopDetectionResult = { count: 1 };
      service.attemptRecovery(result); // 1
      service.attemptRecovery(result); // 2
      service.attemptRecovery(result); // 3
      expect(service.attemptRecovery(result)).toBeNull();
    });

    it('should increment recovery attempts', () => {
      const result: LoopDetectionResult = { count: 1 };
      expect(service.getRecoveryAttempts()).toBe(0);
      service.attemptRecovery(result);
      expect(service.getRecoveryAttempts()).toBe(1);
      service.attemptRecovery(result);
      expect(service.getRecoveryAttempts()).toBe(2);
    });
  });

  describe('shouldAbort', () => {
    it('should return false before any attempts', () => {
      expect(service.shouldAbort()).toBe(false);
    });

    it('should return false before reaching max attempts', () => {
      const result: LoopDetectionResult = { count: 1 };
      service.attemptRecovery(result);
      service.attemptRecovery(result);
      expect(service.shouldAbort()).toBe(false);
    });

    it('should return true after reaching max attempts', () => {
      const result: LoopDetectionResult = { count: 1 };
      service.attemptRecovery(result);
      service.attemptRecovery(result);
      service.attemptRecovery(result);
      expect(service.shouldAbort()).toBe(true);
    });
  });

  describe('reset', () => {
    it('should reset recovery attempts to 0', () => {
      const result: LoopDetectionResult = { count: 1 };
      service.attemptRecovery(result);
      service.attemptRecovery(result);
      expect(service.getRecoveryAttempts()).toBe(2);

      service.reset();
      expect(service.getRecoveryAttempts()).toBe(0);
      expect(service.shouldAbort()).toBe(false);
    });

    it('should allow new attempts after reset', () => {
      const result: LoopDetectionResult = { count: 1 };
      service.attemptRecovery(result);
      service.attemptRecovery(result);
      service.attemptRecovery(result);
      expect(service.shouldAbort()).toBe(true);

      service.reset();
      const message = service.attemptRecovery(result);
      expect(message).not.toBeNull();
      expect(message).toContain('attempt 1/3');
    });
  });

  describe('custom maxRecoveryAttempts', () => {
    it('should respect custom max recovery attempts', () => {
      const customService = new LoopRecoveryService(5);
      const result: LoopDetectionResult = { count: 1 };

      for (let i = 0; i < 5; i++) {
        expect(customService.attemptRecovery(result)).not.toBeNull();
      }
      expect(customService.attemptRecovery(result)).toBeNull();
      expect(customService.shouldAbort()).toBe(true);
    });

    it('should include custom max in messages', () => {
      const customService = new LoopRecoveryService(5);
      const result: LoopDetectionResult = { count: 1 };
      const message = customService.attemptRecovery(result);
      expect(message).toContain('attempt 1/5');
    });
  });
});
