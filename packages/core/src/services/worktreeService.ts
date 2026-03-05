/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WorktreeService provides git worktree isolation for agent teammates.
 *
 * Each agent can be given its own git worktree — an isolated copy of the repo
 * where it can make changes without affecting the main working directory or
 * other agents. Changes can be reviewed via diff before being merged back.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { GEMINI_DIR } from '../utils/paths.js';
import { debugLogger } from '../utils/debugLogger.js';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name created for this worktree. */
  branch: string;
  /** Agent ID this worktree belongs to. */
  agentId: string;
}

/**
 * Manages git worktrees for agent isolation.
 *
 * Worktrees are created under `.gemini/worktrees/<agentId>/` relative to the
 * project root. Each worktree gets its own branch named `gemini-agent/<agentId>`.
 */
export class WorktreeService {
  private readonly projectRoot: string;
  private readonly worktrees: Map<string, WorktreeInfo> = new Map();
  private cleanupRegistered = false;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  /**
   * Check whether the project root is inside a git repository.
   */
  async isGitRepo(): Promise<boolean> {
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: this.projectRoot,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create an isolated worktree for an agent.
   *
   * The worktree is placed at `.gemini/worktrees/<agentId>/` and checked out
   * on a new branch `gemini-agent/<agentId>` starting from HEAD.
   *
   * @param agentId Unique identifier for the agent.
   * @returns WorktreeInfo with the path and branch, or undefined if git is not available.
   */
  async createWorktree(agentId: string): Promise<WorktreeInfo | undefined> {
    if (this.worktrees.has(agentId)) {
      return this.worktrees.get(agentId);
    }

    const isGit = await this.isGitRepo();
    if (!isGit) {
      debugLogger.debug(
        `[WorktreeService] Not a git repo, skipping worktree for ${agentId}`,
      );
      return undefined;
    }

    const worktreePath = path.join(
      this.projectRoot,
      GEMINI_DIR,
      'worktrees',
      agentId,
    );
    const branch = `gemini-agent/${agentId}`;

    try {
      // Ensure parent directory exists
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });

      // Create the worktree with a new branch from HEAD
      await execFileAsync(
        'git',
        ['worktree', 'add', worktreePath, '-b', branch],
        { cwd: this.projectRoot },
      );

      const info: WorktreeInfo = {
        path: worktreePath,
        branch,
        agentId,
      };

      this.worktrees.set(agentId, info);
      this.registerCleanupHandler();

      debugLogger.debug(
        `[WorktreeService] Created worktree for ${agentId} at ${worktreePath}`,
      );

      return info;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      debugLogger.error(
        `[WorktreeService] Failed to create worktree for ${agentId}: ${msg}`,
      );
      return undefined;
    }
  }

  /**
   * List all active worktrees managed by this service.
   */
  listWorktrees(): WorktreeInfo[] {
    return Array.from(this.worktrees.values());
  }

  /**
   * Check if an agent's worktree has any uncommitted changes.
   */
  async hasChanges(agentId: string): Promise<boolean> {
    const info = this.worktrees.get(agentId);
    if (!info) return false;

    try {
      const { stdout } = await execFileAsync(
        'git',
        ['status', '--porcelain'],
        { cwd: info.path },
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Get a diff of all changes made in an agent's worktree relative to HEAD.
   * This includes both staged and unstaged changes.
   */
  async getChanges(agentId: string): Promise<string> {
    const info = this.worktrees.get(agentId);
    if (!info) return '';

    try {
      // Show diff of all changes (staged + unstaged) against HEAD
      const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], {
        cwd: info.path,
      });

      // Also capture untracked files
      const { stdout: untrackedOut } = await execFileAsync(
        'git',
        ['ls-files', '--others', '--exclude-standard'],
        { cwd: info.path },
      );

      let result = '';
      if (stdout.trim()) {
        result += stdout;
      }
      if (untrackedOut.trim()) {
        const untrackedFiles = untrackedOut
          .trim()
          .split('\n')
          .filter(Boolean);
        if (untrackedFiles.length > 0) {
          result += `\n\nUntracked files:\n${untrackedFiles.map((f) => `  ${f}`).join('\n')}`;
        }
      }
      return result;
    } catch {
      return '';
    }
  }

  /**
   * Remove a worktree for an agent.
   *
   * If the worktree has no changes, both the worktree and its branch are removed.
   * If changes exist, a warning is logged and the worktree is left for manual review.
   */
  async removeWorktree(agentId: string): Promise<void> {
    const info = this.worktrees.get(agentId);
    if (!info) return;

    try {
      const changed = await this.hasChanges(agentId);

      if (changed) {
        const diff = await this.getChanges(agentId);
        debugLogger.warn(
          `[WorktreeService] Worktree for ${agentId} has changes, leaving for review:\n${diff.slice(0, 500)}`,
        );
        // Still remove from tracking but leave the files
        this.worktrees.delete(agentId);
        return;
      }

      // Remove the worktree
      await execFileAsync('git', ['worktree', 'remove', info.path, '--force'], {
        cwd: this.projectRoot,
      });

      // Remove the branch
      await execFileAsync('git', ['branch', '-D', info.branch], {
        cwd: this.projectRoot,
      });

      this.worktrees.delete(agentId);

      debugLogger.debug(
        `[WorktreeService] Removed worktree for ${agentId}`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      debugLogger.error(
        `[WorktreeService] Error removing worktree for ${agentId}: ${msg}`,
      );
      this.worktrees.delete(agentId);
    }
  }

  /**
   * Remove all worktrees managed by this service.
   * Worktrees with changes are left for manual review.
   */
  async removeAllWorktrees(): Promise<void> {
    const agentIds = Array.from(this.worktrees.keys());
    await Promise.allSettled(
      agentIds.map((id) => this.removeWorktree(id)),
    );
  }

  /**
   * Register a process exit handler to clean up worktrees.
   * Only registers once.
   */
  private registerCleanupHandler(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;

    const cleanup = () => {
      // Synchronous best-effort cleanup on exit
      for (const info of this.worktrees.values()) {
        try {
          execFileSync('git', ['worktree', 'remove', info.path, '--force'], {
            cwd: this.projectRoot,
            stdio: 'ignore',
          });
          execFileSync('git', ['branch', '-D', info.branch], {
            cwd: this.projectRoot,
            stdio: 'ignore',
          });
        } catch {
          // Best effort — ignore errors on exit
        }
      }
    };

    process.on('exit', cleanup);
    process.on('SIGINT', () => {
      cleanup();
      process.exit(130);
    });
    process.on('SIGTERM', () => {
      cleanup();
      process.exit(143);
    });
  }
}
