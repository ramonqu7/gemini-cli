/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_HARNESS_CONFIG,
  parseDuration,
  mergeHarnessConfig,
} from './harnessConfig.js';

describe('parseDuration', () => {
  it('should parse seconds', () => {
    expect(parseDuration('30s')).toBe(30000);
  });

  it('should parse minutes', () => {
    expect(parseDuration('30m')).toBe(1800000);
  });

  it('should parse hours', () => {
    expect(parseDuration('1h')).toBe(3600000);
  });

  it('should parse days', () => {
    expect(parseDuration('3d')).toBe(259200000);
  });

  it('should return null for invalid input', () => {
    expect(parseDuration('abc')).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseDuration('')).toBeNull();
  });

  it('should return null for missing unit', () => {
    expect(parseDuration('30')).toBeNull();
  });

  it('should return null for missing value', () => {
    expect(parseDuration('m')).toBeNull();
  });

  it('should return null for unknown unit', () => {
    expect(parseDuration('5x')).toBeNull();
  });
});

describe('mergeHarnessConfig', () => {
  it('should return defaults when no overrides given', () => {
    const config = mergeHarnessConfig();
    expect(config).toEqual(DEFAULT_HARNESS_CONFIG);
  });

  it('should not mutate the default config', () => {
    const before = structuredClone(DEFAULT_HARNESS_CONFIG);
    mergeHarnessConfig({ budget: { maxTurns: 50 } });
    expect(DEFAULT_HARNESS_CONFIG).toEqual(before);
  });

  it('should apply a partial budget override', () => {
    const config = mergeHarnessConfig({ budget: { maxTurns: 50 } });
    expect(config.budget.maxTurns).toBe(50);
    // Other budget fields remain default.
    expect(config.budget.maxDuration).toBe('1h');
    expect(config.budget.warningThreshold).toBe(0.8);
    expect(config.budget.checkpointThreshold).toBe(0.95);
  });

  it('should deep merge scope with appended blockedCommands', () => {
    const config = mergeHarnessConfig({
      scope: { blockedCommands: ['docker rm'] },
    });
    expect(config.scope.blockedCommands).toEqual([
      'rm -rf /',
      'git push --force',
      'docker rm',
    ]);
  });

  it('should deep merge scope with appended blockedTools', () => {
    const config = mergeHarnessConfig({
      scope: { blockedTools: ['dangerousTool'] },
    });
    expect(config.scope.blockedTools).toEqual(['dangerousTool']);
  });

  it('should deduplicate appended blockedCommands', () => {
    const config = mergeHarnessConfig({
      scope: { blockedCommands: ['rm -rf /', 'new-cmd'] },
    });
    expect(config.scope.blockedCommands).toEqual([
      'rm -rf /',
      'git push --force',
      'new-cmd',
    ]);
  });

  it('should override allowedDirectories (replace, not append)', () => {
    const config = mergeHarnessConfig({
      scope: { allowedDirectories: ['/tmp'] },
    });
    expect(config.scope.allowedDirectories).toEqual(['/tmp']);
  });

  it('should apply checkpoint overrides', () => {
    const config = mergeHarnessConfig({
      checkpoints: { every: 10, onFileDelete: false },
    });
    expect(config.checkpoints.every).toBe(10);
    expect(config.checkpoints.onFileDelete).toBe(false);
    expect(config.checkpoints.onGitOperation).toBe(true);
  });

  it('should apply loop overrides', () => {
    const config = mergeHarnessConfig({
      loop: { maxConcurrent: 10, enabled: false },
    });
    expect(config.loop.maxConcurrent).toBe(10);
    expect(config.loop.enabled).toBe(false);
    expect(config.loop.defaultInterval).toBe('10m');
  });

  it('should apply multiple layered overrides in order', () => {
    const config = mergeHarnessConfig(
      { budget: { maxTurns: 50 } },
      { budget: { maxTurns: 200, maxDuration: '2h' } },
    );
    expect(config.budget.maxTurns).toBe(200);
    expect(config.budget.maxDuration).toBe('2h');
  });
});
