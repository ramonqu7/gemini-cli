/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Budget limits for a harness session.
 */
export interface HarnessBudgetConfig {
  maxTurns: number;
  maxDuration: string; // '1h', '30m', '3d'
  warningThreshold: number; // 0.0-1.0
  checkpointThreshold: number; // 0.0-1.0
}

/**
 * Scope restrictions for a harness session.
 */
export interface HarnessScopeConfig {
  allowedDirectories: string[];
  blockedCommands: string[];
  blockedTools: string[];
}

/**
 * Checkpoint configuration for a harness session.
 */
export interface HarnessCheckpointConfig {
  every: number; // 0=disabled, N=every N turns
  onFileDelete: boolean;
  onGitOperation: boolean;
}

/**
 * Loop configuration for a harness session.
 */
export interface HarnessLoopConfig {
  enabled: boolean;
  maxConcurrent: number;
  defaultInterval: string;
  maxDuration: string;
}

/**
 * Top-level harness configuration.
 */
export interface HarnessConfig {
  budget: HarnessBudgetConfig;
  scope: HarnessScopeConfig;
  checkpoints: HarnessCheckpointConfig;
  loop: HarnessLoopConfig;
}

/**
 * Deeply partial version of HarnessConfig for layered overrides.
 */
export type PartialHarnessConfig = {
  budget?: Partial<HarnessBudgetConfig>;
  scope?: Partial<HarnessScopeConfig>;
  checkpoints?: Partial<HarnessCheckpointConfig>;
  loop?: Partial<HarnessLoopConfig>;
};

/**
 * Default harness configuration values.
 */
export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  budget: {
    maxTurns: 100,
    maxDuration: '1h',
    warningThreshold: 0.8,
    checkpointThreshold: 0.95,
  },
  scope: {
    allowedDirectories: [],
    blockedCommands: ['rm -rf /', 'git push --force'],
    blockedTools: [],
  },
  checkpoints: {
    every: 0,
    onFileDelete: true,
    onGitOperation: true,
  },
  loop: {
    enabled: true,
    maxConcurrent: 5,
    defaultInterval: '10m',
    maxDuration: '3d',
  },
};

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * Parses a duration string (e.g. '30m', '1h', '3d', '30s') into milliseconds.
 * Returns null if the input is invalid.
 */
export function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)([smhd])$/);
  if (!match) {
    return null;
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multiplier = DURATION_UNITS[unit];
  if (multiplier === undefined) {
    return null;
  }
  return value * multiplier;
}

/**
 * Deep-merges partial overrides onto the default harness config.
 *
 * For `scope.blockedCommands` and `scope.blockedTools`, values are appended
 * (union with defaults) rather than replaced. All other fields are replaced
 * by the override value.
 */
export function mergeHarnessConfig(
  ...overrides: PartialHarnessConfig[]
): HarnessConfig {
  // Start with a deep clone of defaults.
  const result: HarnessConfig = structuredClone(DEFAULT_HARNESS_CONFIG);

  for (const override of overrides) {
    if (override.budget) {
      Object.assign(result.budget, override.budget);
    }
    if (override.scope) {
      const { blockedCommands, blockedTools, ...rest } = override.scope;
      Object.assign(result.scope, rest);
      if (blockedCommands) {
        const merged = new Set([
          ...result.scope.blockedCommands,
          ...blockedCommands,
        ]);
        result.scope.blockedCommands = [...merged];
      }
      if (blockedTools) {
        const merged = new Set([...result.scope.blockedTools, ...blockedTools]);
        result.scope.blockedTools = [...merged];
      }
    }
    if (override.checkpoints) {
      Object.assign(result.checkpoints, override.checkpoints);
    }
    if (override.loop) {
      Object.assign(result.loop, override.loop);
    }
  }

  return result;
}
