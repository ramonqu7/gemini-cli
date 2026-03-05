/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  ToolPermissionService,
  type ToolPermissionRule,
} from './toolPermissionService.js';

describe('ToolPermissionService', () => {
  describe('constructor', () => {
    it('should compile valid rules', () => {
      const rules: ToolPermissionRule[] = [
        {
          tool: 'run_shell_command',
          allow: ['^npm test'],
          deny: ['^rm -rf'],
        },
      ];
      const service = new ToolPermissionService(rules);
      expect(service.getRuleCount()).toBe(1);
    });

    it('should skip rules with no valid patterns', () => {
      const rules: ToolPermissionRule[] = [
        {
          tool: 'run_shell_command',
          // No allow or deny patterns
        },
      ];
      const service = new ToolPermissionService(rules);
      expect(service.getRuleCount()).toBe(0);
    });

    it('should skip rules with invalid regex patterns', () => {
      const rules: ToolPermissionRule[] = [
        {
          tool: 'run_shell_command',
          allow: ['[invalid'], // Invalid regex
        },
      ];
      const service = new ToolPermissionService(rules);
      expect(service.getRuleCount()).toBe(0);
    });

    it('should skip unsafe regex patterns (nested quantifiers)', () => {
      const rules: ToolPermissionRule[] = [
        {
          tool: 'run_shell_command',
          allow: ['(a+)+'], // ReDoS-vulnerable
        },
      ];
      const service = new ToolPermissionService(rules);
      expect(service.getRuleCount()).toBe(0);
    });

    it('should handle mixed valid and invalid patterns', () => {
      const rules: ToolPermissionRule[] = [
        {
          tool: 'run_shell_command',
          allow: ['^npm test', '[invalid'],
          deny: ['^rm -rf'],
        },
      ];
      const service = new ToolPermissionService(rules);
      // Rule should still be compiled with valid patterns
      expect(service.getRuleCount()).toBe(1);
    });
  });

  describe('checkPermission - shell tool', () => {
    const rules: ToolPermissionRule[] = [
      {
        tool: 'run_shell_command',
        allow: ['^npm (test|run build|run lint)', '^git (status|diff|log)'],
        deny: ['^rm -rf', '^git push --force', '^sudo'],
      },
    ];
    const service = new ToolPermissionService(rules);

    it('should allow matching shell commands', () => {
      expect(
        service.checkPermission('run_shell_command', {
          command: 'npm test',
        }),
      ).toBe('allow');

      expect(
        service.checkPermission('run_shell_command', {
          command: 'npm run build',
        }),
      ).toBe('allow');

      expect(
        service.checkPermission('run_shell_command', {
          command: 'git status',
        }),
      ).toBe('allow');

      expect(
        service.checkPermission('run_shell_command', {
          command: 'git diff --staged',
        }),
      ).toBe('allow');
    });

    it('should deny matching shell commands', () => {
      expect(
        service.checkPermission('run_shell_command', {
          command: 'rm -rf /',
        }),
      ).toBe('deny');

      expect(
        service.checkPermission('run_shell_command', {
          command: 'git push --force origin main',
        }),
      ).toBe('deny');

      expect(
        service.checkPermission('run_shell_command', {
          command: 'sudo rm something',
        }),
      ).toBe('deny');
    });

    it('should return ask for non-matching commands', () => {
      expect(
        service.checkPermission('run_shell_command', {
          command: 'echo hello',
        }),
      ).toBe('ask');

      expect(
        service.checkPermission('run_shell_command', {
          command: 'git push origin main',
        }),
      ).toBe('ask');
    });

    it('should deny before allow when both match', () => {
      // A command that matches both allow and deny: "sudo npm test"
      const mixedRules: ToolPermissionRule[] = [
        {
          tool: 'run_shell_command',
          allow: ['^npm test', 'sudo npm test'],
          deny: ['^sudo'],
        },
      ];
      const mixedService = new ToolPermissionService(mixedRules);

      expect(
        mixedService.checkPermission('run_shell_command', {
          command: 'sudo npm test',
        }),
      ).toBe('deny');
    });

    it('should handle ShellTool alias', () => {
      expect(
        service.checkPermission('ShellTool', {
          command: 'npm test',
        }),
      ).toBe('allow');

      expect(
        service.checkPermission('ShellTool', {
          command: 'rm -rf /',
        }),
      ).toBe('deny');
    });
  });

  describe('checkPermission - edit tool', () => {
    const rules: ToolPermissionRule[] = [
      {
        tool: 'replace',
        allow: ['^src/'],
        deny: ['node_modules/', '\\.env$'],
      },
    ];
    const service = new ToolPermissionService(rules);

    it('should allow matching file paths', () => {
      expect(
        service.checkPermission('replace', {
          file_path: 'src/index.ts',
        }),
      ).toBe('allow');

      expect(
        service.checkPermission('replace', {
          file_path: 'src/utils/helper.ts',
        }),
      ).toBe('allow');
    });

    it('should deny matching file paths', () => {
      expect(
        service.checkPermission('replace', {
          file_path: 'node_modules/lodash/index.js',
        }),
      ).toBe('deny');

      expect(
        service.checkPermission('replace', {
          file_path: 'config/.env',
        }),
      ).toBe('deny');
    });

    it('should return ask for non-matching paths', () => {
      expect(
        service.checkPermission('replace', {
          file_path: 'tests/index.test.ts',
        }),
      ).toBe('ask');
    });
  });

  describe('checkPermission - write_file tool', () => {
    const rules: ToolPermissionRule[] = [
      {
        tool: 'write_file',
        deny: ['\\.env$', 'credentials', 'secrets'],
      },
    ];
    const service = new ToolPermissionService(rules);

    it('should deny matching file paths', () => {
      expect(
        service.checkPermission('write_file', {
          file_path: '.env',
        }),
      ).toBe('deny');

      expect(
        service.checkPermission('write_file', {
          file_path: 'config/credentials.json',
        }),
      ).toBe('deny');

      expect(
        service.checkPermission('write_file', {
          file_path: 'secrets/api-key.txt',
        }),
      ).toBe('deny');
    });

    it('should return ask for safe file paths', () => {
      expect(
        service.checkPermission('write_file', {
          file_path: 'src/index.ts',
        }),
      ).toBe('ask');
    });
  });

  describe('checkPermission - wildcard tool', () => {
    const rules: ToolPermissionRule[] = [
      {
        tool: '*',
        deny: ['password', 'secret_key'],
      },
    ];
    const service = new ToolPermissionService(rules);

    it('should apply to any tool', () => {
      expect(
        service.checkPermission('run_shell_command', {
          command: 'echo password123',
        }),
      ).toBe('deny');

      expect(
        service.checkPermission('write_file', {
          file_path: 'secret_key.txt',
        }),
      ).toBe('deny');
    });

    it('should return ask when not matching', () => {
      expect(
        service.checkPermission('run_shell_command', {
          command: 'npm test',
        }),
      ).toBe('ask');
    });
  });

  describe('checkPermission - multiple rules', () => {
    it('should process rules in order', () => {
      const rules: ToolPermissionRule[] = [
        {
          tool: 'run_shell_command',
          deny: ['^rm'],
        },
        {
          tool: 'run_shell_command',
          allow: ['^rm -i'], // rm with interactive flag
        },
      ];
      const service = new ToolPermissionService(rules);

      // First rule denies "rm" before second rule can allow "rm -i"
      expect(
        service.checkPermission('run_shell_command', {
          command: 'rm -i file.txt',
        }),
      ).toBe('deny');
    });
  });

  describe('checkPermission - no matchable arg', () => {
    it('should return ask when tool has no matchable argument', () => {
      const rules: ToolPermissionRule[] = [
        {
          tool: 'some_tool',
          allow: ['^allowed'],
          deny: ['^denied'],
        },
      ];
      const service = new ToolPermissionService(rules);

      expect(
        service.checkPermission('some_tool', {
          other_param: 'value',
        }),
      ).toBe('ask');
    });
  });

  describe('getMatchableArg', () => {
    const service = new ToolPermissionService([]);

    it('should return command for shell tools', () => {
      expect(
        service.getMatchableArg('run_shell_command', {
          command: 'npm test',
        }),
      ).toBe('npm test');
    });

    it('should return file_path for edit tools', () => {
      expect(
        service.getMatchableArg('replace', { file_path: 'src/index.ts' }),
      ).toBe('src/index.ts');
    });

    it('should return file_path for write_file tools', () => {
      expect(
        service.getMatchableArg('write_file', { file_path: 'test.txt' }),
      ).toBe('test.txt');
    });

    it('should return null when no matchable arg is found', () => {
      expect(
        service.getMatchableArg('unknown_tool', { other: 'value' }),
      ).toBeNull();
    });

    it('should fall back to command arg for unknown tools', () => {
      expect(
        service.getMatchableArg('custom_tool', {
          command: 'something',
        }),
      ).toBe('something');
    });

    it('should fall back to file_path arg for unknown tools', () => {
      expect(
        service.getMatchableArg('custom_tool', {
          file_path: '/some/path',
        }),
      ).toBe('/some/path');
    });
  });

  describe('empty rules', () => {
    it('should return ask for everything with no rules', () => {
      const service = new ToolPermissionService([]);

      expect(
        service.checkPermission('run_shell_command', {
          command: 'anything',
        }),
      ).toBe('ask');
    });
  });
});
