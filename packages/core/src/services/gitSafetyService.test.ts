/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { GitSafetyService } from './gitSafetyService.js';

describe('GitSafetyService', () => {
  const service = new GitSafetyService();

  describe('Block rules', () => {
    describe('force-push to protected branches', () => {
      it('should block git push --force to main', () => {
        const result = service.checkCommand('git push --force origin main');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Force-pushing to main/master');
      });

      it('should block git push -f to master', () => {
        const result = service.checkCommand('git push -f origin master');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Force-pushing to main/master');
      });

      it('should block git push origin main --force', () => {
        const result = service.checkCommand('git push origin main --force');
        expect(result.allowed).toBe(false);
      });
    });

    describe('git reset --hard', () => {
      it('should block git reset --hard', () => {
        const result = service.checkCommand('git reset --hard');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('git reset --hard');
      });

      it('should block git reset --hard HEAD~1', () => {
        const result = service.checkCommand('git reset --hard HEAD~1');
        expect(result.allowed).toBe(false);
      });
    });

    describe('git clean -f', () => {
      it('should block git clean -f', () => {
        const result = service.checkCommand('git clean -f');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('git clean -f');
      });

      it('should block git clean -fd', () => {
        const result = service.checkCommand('git clean -fd');
        expect(result.allowed).toBe(false);
      });
    });

    describe('git checkout .', () => {
      it('should block git checkout .', () => {
        const result = service.checkCommand('git checkout .');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('git checkout .');
      });
    });

    describe('git restore .', () => {
      it('should block git restore .', () => {
        const result = service.checkCommand('git restore .');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('git restore .');
      });
    });

    describe('git branch -D', () => {
      it('should block git branch -D', () => {
        const result = service.checkCommand('git branch -D feature-branch');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('git branch -D');
      });
    });

    describe('chained commands', () => {
      it('should block when dangerous command is chained with safe commands', () => {
        const result = service.checkCommand(
          'git add . && git reset --hard HEAD',
        );
        expect(result.allowed).toBe(false);
      });

      it('should block when dangerous command is piped', () => {
        const result = service.checkCommand(
          'echo yes | git push --force origin main',
        );
        expect(result.allowed).toBe(false);
      });
    });
  });

  describe('Warn rules', () => {
    describe('force-push to non-protected branches', () => {
      it('should warn on git push --force to feature branch', () => {
        const result = service.checkCommand(
          'git push --force origin feature-branch',
        );
        expect(result.allowed).toBe(true);
        expect(result.warning).toContain('Force-pushing');
        expect(result.suggestion).toContain('--force-with-lease');
      });

      it('should warn on git push -f to feature branch', () => {
        const result = service.checkCommand(
          'git push -f origin feature-branch',
        );
        expect(result.allowed).toBe(true);
        expect(result.warning).toBeDefined();
      });
    });

    describe('git commit --amend', () => {
      it('should warn on git commit --amend', () => {
        const result = service.checkCommand('git commit --amend');
        expect(result.allowed).toBe(true);
        expect(result.warning).toContain('Amending');
        expect(result.suggestion).toContain('new commit');
      });

      it('should warn on git commit --amend -m "message"', () => {
        const result = service.checkCommand(
          'git commit --amend -m "fix typo"',
        );
        expect(result.allowed).toBe(true);
        expect(result.warning).toBeDefined();
      });
    });

    describe('git rebase -i', () => {
      it('should warn on git rebase -i', () => {
        const result = service.checkCommand('git rebase -i HEAD~3');
        expect(result.allowed).toBe(true);
        expect(result.warning).toContain('rebase');
      });
    });

    describe('git stash drop', () => {
      it('should warn on git stash drop', () => {
        const result = service.checkCommand('git stash drop');
        expect(result.allowed).toBe(true);
        expect(result.warning).toContain('stash');
      });
    });

    describe('--no-verify', () => {
      it('should warn on git commit --no-verify', () => {
        const result = service.checkCommand(
          'git commit -m "message" --no-verify',
        );
        expect(result.allowed).toBe(true);
        expect(result.warning).toContain('--no-verify');
        expect(result.suggestion).toContain('hook');
      });

      it('should warn on git push --no-verify', () => {
        const result = service.checkCommand('git push --no-verify');
        expect(result.allowed).toBe(true);
        expect(result.warning).toContain('--no-verify');
      });
    });
  });

  describe('Safe commands', () => {
    it('should allow git status', () => {
      const result = service.checkCommand('git status');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('should allow git log', () => {
      const result = service.checkCommand('git log --oneline -10');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('should allow git diff', () => {
      const result = service.checkCommand('git diff HEAD');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('should allow git add', () => {
      const result = service.checkCommand('git add .');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('should allow git commit without --amend', () => {
      const result = service.checkCommand('git commit -m "feat: add feature"');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('should allow git push without --force', () => {
      const result = service.checkCommand('git push origin feature-branch');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('should allow git push --force-with-lease', () => {
      const result = service.checkCommand(
        'git push --force-with-lease origin feature-branch',
      );
      expect(result.allowed).toBe(true);
      // --force-with-lease should NOT trigger force-push warning
      // because the regex requires --force or -f specifically
    });

    it('should allow git branch -d (lowercase)', () => {
      const result = service.checkCommand('git branch -d feature-branch');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('should allow git checkout specific file', () => {
      const result = service.checkCommand('git checkout -- src/file.ts');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('should allow git restore specific file', () => {
      const result = service.checkCommand('git restore src/file.ts');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('should allow non-git commands', () => {
      const result = service.checkCommand('npm test');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });

    it('should allow git reset without --hard', () => {
      const result = service.checkCommand('git reset HEAD~1');
      expect(result.allowed).toBe(true);
      expect(result.warning).toBeUndefined();
    });
  });

  describe('getGitSafetyRules', () => {
    it('should return a non-empty string with safety rules', () => {
      const rules = service.getGitSafetyRules();
      expect(rules).toContain('Git Safety Rules');
      expect(rules).toContain('NEVER');
      expect(rules).toContain('force-push');
      expect(rules).toContain('git reset --hard');
    });
  });
});
