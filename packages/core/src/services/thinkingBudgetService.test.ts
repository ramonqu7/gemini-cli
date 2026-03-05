/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ThinkingBudgetService } from './thinkingBudgetService.js';

describe('ThinkingBudgetService', () => {
  let service: ThinkingBudgetService;

  beforeEach(() => {
    service = new ThinkingBudgetService();
  });

  describe('classifyComplexity', () => {
    describe('simple tasks', () => {
      it('should classify short questions as simple', () => {
        expect(service.classifyComplexity('What is TypeScript?')).toBe('simple');
      });

      it('should classify "how to" questions as simple', () => {
        expect(service.classifyComplexity('How do I install Node.js?')).toBe('simple');
      });

      it('should classify prompts ending with question marks as simple', () => {
        expect(service.classifyComplexity('Where is the config file?')).toBe('simple');
      });

      it('should classify "show" commands as simple', () => {
        expect(service.classifyComplexity('Show me the contents of the file')).toBe('simple');
      });

      it('should classify "explain" prompts as simple', () => {
        expect(service.classifyComplexity('Explain what this function does')).toBe('simple');
      });

      it('should classify very short prompts as simple', () => {
        expect(service.classifyComplexity('hello')).toBe('simple');
      });
    });

    describe('moderate tasks', () => {
      it('should classify "add" tasks as moderate', () => {
        expect(service.classifyComplexity('Add a new logging function to the service')).toBe('moderate');
      });

      it('should classify "fix" tasks as moderate', () => {
        expect(service.classifyComplexity('Fix the typo in the error message')).toBe('moderate');
      });

      it('should classify prompts referencing a file path as moderate', () => {
        expect(service.classifyComplexity('Look at packages/core/src/config.ts')).toBe('moderate');
      });

      it('should classify "update" tasks as moderate', () => {
        expect(service.classifyComplexity('Update the version number in package.json')).toBe('moderate');
      });

      it('should classify "create" tasks as moderate', () => {
        expect(service.classifyComplexity('Create a new utility function for string formatting')).toBe('moderate');
      });
    });

    describe('complex tasks', () => {
      it('should classify "debug" tasks as complex', () => {
        expect(service.classifyComplexity('Debug the failing test in packages/core/src/services/auth.ts and fix the issue')).toBe('complex');
      });

      it('should classify "refactor" tasks as complex', () => {
        expect(service.classifyComplexity('Refactor the authentication module to use the new token system')).toBe('complex');
      });

      it('should classify tasks with "investigate" as complex', () => {
        expect(service.classifyComplexity('Investigate why the API calls are timing out in the production environment')).toBe('complex');
      });

      it('should classify tasks referencing multiple files as complex', () => {
        expect(
          service.classifyComplexity(
            'Update packages/core/src/auth.ts and packages/cli/src/commands/login.ts to use the new auth flow'
          )
        ).toBe('complex');
      });
    });

    describe('deep tasks', () => {
      it('should classify "design" + "system" tasks as deep', () => {
        expect(
          service.classifyComplexity(
            'Design a new caching system with performance considerations and migrate the existing data layer'
          )
        ).toBe('deep');
      });

      it('should classify "security audit" as deep', () => {
        expect(
          service.classifyComplexity(
            'Perform a comprehensive security audit of the authentication system and design remediation steps'
          )
        ).toBe('deep');
      });

      it('should classify very long prompts with deep keywords as deep', () => {
        const longPrompt = 'We need to design ' + 'a complex system '.repeat(30) + 'with proper scalability';
        expect(service.classifyComplexity(longPrompt)).toBe('deep');
      });
    });

    describe('context influence', () => {
      it('should consider recent context for classification', () => {
        const prompt = 'Can you help with this?';
        const context = 'We are debugging the authentication flow and investigating race conditions across multiple services';
        // Without context this would be simple, but context should push it higher
        const withoutContext = service.classifyComplexity(prompt);
        const withContext = service.classifyComplexity(prompt, context);
        expect(withoutContext).toBe('simple');
        // With context containing debug + investigate + multiple keywords
        expect(withContext).toBe('complex');
      });
    });
  });

  describe('getBudget', () => {
    it('should return 1024 for simple', () => {
      expect(service.getBudget('simple')).toBe(1024);
    });

    it('should return 4096 for moderate', () => {
      expect(service.getBudget('moderate')).toBe(4096);
    });

    it('should return 8192 for complex', () => {
      expect(service.getBudget('complex')).toBe(8192);
    });

    it('should return 16384 for deep', () => {
      expect(service.getBudget('deep')).toBe(16384);
    });
  });

  describe('getBudgetForSubagent', () => {
    it('should return moderate budget for researcher', () => {
      expect(service.getBudgetForSubagent('researcher')).toBe(4096);
    });

    it('should return moderate budget for explorer', () => {
      expect(service.getBudgetForSubagent('explorer')).toBe(4096);
    });

    it('should return complex budget for worker', () => {
      expect(service.getBudgetForSubagent('worker')).toBe(8192);
    });

    it('should return complex budget for implementer', () => {
      expect(service.getBudgetForSubagent('implementer')).toBe(8192);
    });

    it('should return complex budget for reviewer', () => {
      expect(service.getBudgetForSubagent('reviewer')).toBe(8192);
    });

    it('should be case-insensitive', () => {
      expect(service.getBudgetForSubagent('RESEARCHER')).toBe(4096);
      expect(service.getBudgetForSubagent('Worker')).toBe(8192);
    });

    it('should return complex budget as default for unknown roles', () => {
      expect(service.getBudgetForSubagent('unknown-role')).toBe(8192);
    });
  });

  describe('recommendBudget', () => {
    it('should return both complexity and budget', () => {
      const result = service.recommendBudget('What is TypeScript?');
      expect(result.complexity).toBe('simple');
      expect(result.budget).toBe(1024);
    });

    it('should return complex budget for debugging prompts', () => {
      const result = service.recommendBudget(
        'Debug the failing test and investigate the root cause in packages/core/src/auth.ts'
      );
      expect(result.complexity).toBe('complex');
      expect(result.budget).toBe(8192);
    });
  });
});
