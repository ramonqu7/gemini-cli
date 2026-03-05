/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Generates fresh per-turn context (git status, working directory, modified
 * files) so the model always has an accurate picture of the workspace.
 *
 * The context is cached for a short TTL to avoid hammering git on rapid
 * successive turns.
 */

import { spawnAsync } from '../utils/shell-utils.js';
import { isGitRepository } from '../utils/gitUtils.js';
import type { StateSnapshotService } from './stateSnapshotService.js';

/** Maximum number of files to list in the dynamic context block. */
const MAX_FILES = 20;

/** Cache TTL in milliseconds. */
const CACHE_TTL_MS = 5_000;

/** Status code labels for `git status --porcelain` output. */
const STATUS_LABELS: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  '?': 'untracked',
  '!': 'ignored',
};

interface GitFileEntry {
  path: string;
  status: string;
}

interface CachedSnapshot {
  value: string;
  timestamp: number;
}

export class DynamicContextService {
  private cache: CachedSnapshot | null = null;
  private lastWorkingDir: string | null = null;

  /**
   * Return a fresh `<dynamic_context>` block.
   *
   * @param workingDir  The current working directory.
   * @param stateSnapshotService  Optional — supplies files modified during this
   *   session (e.g. via write-file / edit tools).
   */
  async getContextSnapshot(
    workingDir: string,
    stateSnapshotService?: StateSnapshotService,
  ): Promise<string> {
    // Invalidate cache when the working directory changes.
    if (this.lastWorkingDir !== workingDir) {
      this.cache = null;
      this.lastWorkingDir = workingDir;
    }

    // Return cached value if still fresh.
    if (this.cache && Date.now() - this.cache.timestamp < CACHE_TTL_MS) {
      return this.cache.value;
    }

    const snapshot = await this.buildSnapshot(
      workingDir,
      stateSnapshotService,
    );

    this.cache = { value: snapshot, timestamp: Date.now() };
    return snapshot;
  }

  /** Invalidate the cache (e.g. after a tool modifies files). */
  invalidate(): void {
    this.cache = null;
  }

  /** Reset all state. Call on session reset. */
  reset(): void {
    this.cache = null;
    this.lastWorkingDir = null;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async buildSnapshot(
    workingDir: string,
    stateSnapshotService?: StateSnapshotService,
  ): Promise<string> {
    const parts: string[] = ['<dynamic_context>'];
    parts.push(`Working Directory: ${workingDir}`);

    // Git information (skip if not a git repo).
    if (isGitRepository(workingDir)) {
      const branch = await this.getGitBranch(workingDir);
      if (branch) {
        parts.push(`Git Branch: ${branch}`);
      }

      const files = await this.getGitStatus(workingDir);
      if (files.length === 0) {
        parts.push('Git Status: clean');
      } else {
        const counts = this.summariseCounts(files);
        parts.push(`Git Status: ${counts}`);
        parts.push('Changed Files:');

        const display = files.slice(0, MAX_FILES);
        for (const f of display) {
          parts.push(`  - ${f.path} (${f.status})`);
        }
        if (files.length > MAX_FILES) {
          parts.push(`  ... and ${files.length - MAX_FILES} more`);
        }
      }
    }

    // Files modified during *this session* (tracked by tools).
    if (stateSnapshotService) {
      const sessionFiles = stateSnapshotService.getModifiedFiles();
      if (sessionFiles.size > 0) {
        const arr = [...sessionFiles];
        parts.push('Session Modified Files:');
        const display = arr.slice(0, MAX_FILES);
        for (const f of display) {
          parts.push(`  - ${f}`);
        }
        if (arr.length > MAX_FILES) {
          parts.push(`  ... and ${arr.length - MAX_FILES} more`);
        }
      }
    }

    parts.push('</dynamic_context>');
    return parts.join('\n');
  }

  private async getGitBranch(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await spawnAsync(
        'git',
        ['branch', '--show-current'],
        { cwd },
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async getGitStatus(cwd: string): Promise<GitFileEntry[]> {
    try {
      const { stdout } = await spawnAsync(
        'git',
        ['status', '--porcelain'],
        { cwd },
      );

      if (!stdout.trim()) {
        return [];
      }

      const entries: GitFileEntry[] = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        // Porcelain format: XY <path>
        // X = index status, Y = worktree status
        const statusCode = line.substring(0, 2).trim();
        const filePath = line.substring(3);
        const label =
          STATUS_LABELS[statusCode.charAt(0)] ??
          STATUS_LABELS[statusCode.charAt(1)] ??
          'changed';
        entries.push({ path: filePath, status: label });
      }

      return entries;
    } catch {
      return [];
    }
  }

  private summariseCounts(files: GitFileEntry[]): string {
    const counts = new Map<string, number>();
    for (const f of files) {
      counts.set(f.status, (counts.get(f.status) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([status, count]) => `${count} ${status}`)
      .join(', ');
  }
}
