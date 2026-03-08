/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import { describe, it, expect } from 'vitest';
import { ScopeEnforcerService } from './scopeEnforcerService.js';
import type { HarnessScopeConfig } from './harnessConfig.js';

describe('ScopeEnforcerService', () => {
  const config: HarnessScopeConfig = {
    allowedDirectories: ['/home/user/project/src', '/home/user/project/tests'],
    blockedCommands: ['rm -rf /', 'git push --force'],
    blockedTools: ['dangerous_tool'],
  };
  const cwd = '/home/user/project';

  describe('isPathAllowed', () => {
    it('allows paths within allowed directories', () => {
      const enforcer = new ScopeEnforcerService(config, cwd);
      expect(enforcer.isPathAllowed('/home/user/project/src/index.ts')).toBe(
        true,
      );
      expect(
        enforcer.isPathAllowed('/home/user/project/tests/foo.test.ts'),
      ).toBe(true);
    });

    it('blocks paths outside allowed directories', () => {
      const enforcer = new ScopeEnforcerService(config, cwd);
      expect(enforcer.isPathAllowed('/etc/passwd')).toBe(false);
      expect(enforcer.isPathAllowed('/home/user/other/file.ts')).toBe(false);
    });

    it('allows any path when allowedDirectories is empty', () => {
      const openConfig: HarnessScopeConfig = {
        allowedDirectories: [],
        blockedCommands: [],
        blockedTools: [],
      };
      const enforcer = new ScopeEnforcerService(openConfig, cwd);
      expect(enforcer.isPathAllowed('/etc/passwd')).toBe(true);
      expect(enforcer.isPathAllowed('/anywhere/at/all')).toBe(true);
    });
  });

  describe('isCommandAllowed', () => {
    it('blocks commands matching blocklist', () => {
      const enforcer = new ScopeEnforcerService(config, cwd);
      expect(enforcer.isCommandAllowed('rm -rf /')).toBe(false);
      expect(enforcer.isCommandAllowed('git push --force')).toBe(false);
    });

    it('blocks commands containing blocked patterns', () => {
      const enforcer = new ScopeEnforcerService(config, cwd);
      expect(enforcer.isCommandAllowed('git push --force origin main')).toBe(
        false,
      );
    });

    it('allows commands not on blocklist', () => {
      const enforcer = new ScopeEnforcerService(config, cwd);
      expect(enforcer.isCommandAllowed('git status')).toBe(true);
      expect(enforcer.isCommandAllowed('npm test')).toBe(true);
    });
  });

  describe('isToolAllowed', () => {
    it('blocks tools on blocklist', () => {
      const enforcer = new ScopeEnforcerService(config, cwd);
      expect(enforcer.isToolAllowed('dangerous_tool')).toBe(false);
    });

    it('allows tools not on blocklist', () => {
      const enforcer = new ScopeEnforcerService(config, cwd);
      expect(enforcer.isToolAllowed('safe_tool')).toBe(true);
      expect(enforcer.isToolAllowed('another_tool')).toBe(true);
    });
  });

  describe('getViolationMessage', () => {
    it('returns a message for path violations', () => {
      const enforcer = new ScopeEnforcerService(config, cwd);
      const msg = enforcer.getViolationMessage('path', '/etc/passwd');
      expect(msg).toContain('/etc/passwd');
      expect(msg).toContain('denied');
    });

    it('returns a message for command violations', () => {
      const enforcer = new ScopeEnforcerService(config, cwd);
      const msg = enforcer.getViolationMessage('command', 'rm -rf /');
      expect(msg).toContain('rm -rf /');
      expect(msg).toContain('blocked');
    });

    it('returns a message for tool violations', () => {
      const enforcer = new ScopeEnforcerService(config, cwd);
      const msg = enforcer.getViolationMessage('tool', 'dangerous_tool');
      expect(msg).toContain('dangerous_tool');
      expect(msg).toContain('blocked');
    });
  });
});
