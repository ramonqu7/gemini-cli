/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git Safety Service
 *
 * Provides hardcoded safety checks for destructive git operations.
 * These checks are enforced regardless of approval mode (including YOLO).
 *
 * Inspired by Claude Code's git safety protocols:
 * - Never force-push to main/master
 * - Never amend published commits without explicit request
 * - Never skip hooks (--no-verify)
 * - Never use git reset --hard without explicit user request
 * - Prefer new commits over amending
 * - Warn before destructive operations
 */

export interface GitSafetyCheck {
  /** Whether the command is allowed to proceed */
  allowed: boolean;
  /** Why the command was blocked (only set when allowed=false) */
  reason?: string;
  /** What to do instead (set for both blocks and warnings) */
  suggestion?: string;
  /** Warning message (set when allowed=true but command is risky) */
  warning?: string;
}

/**
 * Patterns that are always blocked (return allowed: false).
 *
 * Each entry has:
 * - pattern: regex to match against the full command string
 * - reason: human-readable explanation of why it's blocked
 * - suggestion: what to do instead
 */
interface BlockRule {
  pattern: RegExp;
  reason: string;
  suggestion: string;
}

/**
 * Patterns that produce warnings (return allowed: true with warning).
 */
interface WarnRule {
  pattern: RegExp;
  warning: string;
  suggestion: string;
}

const BLOCK_RULES: BlockRule[] = [
  // Force-push to main/master
  {
    pattern:
      /\bgit\s+push\s+(?:.*\s+)?(?:--force|-f)(?:\s|$).*?\b(?:main|master)\b/,
    reason: 'Force-pushing to main/master is blocked for safety.',
    suggestion:
      'Push to a feature branch instead, or use --force-with-lease on a non-protected branch.',
  },
  // Also catch: git push origin main --force (branch before flag)
  {
    pattern:
      /\bgit\s+push\s+\S+\s+(?:main|master)(?:\s+.*)?(?:--force|-f)(?:\s|$)/,
    reason: 'Force-pushing to main/master is blocked for safety.',
    suggestion:
      'Push to a feature branch instead, or use --force-with-lease on a non-protected branch.',
  },
  // git reset --hard (without explicit path — full working tree reset)
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    reason:
      'git reset --hard discards all uncommitted changes and is blocked for safety.',
    suggestion:
      'Use git stash to save changes, or git checkout -- <file> to discard specific files.',
  },
  // git clean -f without -n (dry run) — handles combined flags like -fd, -fxd, etc.
  {
    pattern: /\bgit\s+clean\s+(?:(?!.*-n)(?!.*--dry-run)).*-[a-zA-Z]*f/,
    reason:
      'git clean -f permanently deletes untracked files and is blocked for safety.',
    suggestion:
      'Use git clean -n first to preview what would be deleted, then confirm with the user.',
  },
  // git checkout . (discard all changes)
  {
    pattern: /\bgit\s+checkout\s+\.\s*$/,
    reason:
      'git checkout . discards all uncommitted changes and is blocked for safety.',
    suggestion:
      'Use git checkout -- <specific-file> to discard changes to specific files, or git stash to save them.',
  },
  // git restore . (discard all changes)
  {
    pattern: /\bgit\s+restore\s+\.\s*$/,
    reason:
      'git restore . discards all uncommitted changes and is blocked for safety.',
    suggestion:
      'Use git restore <specific-file> to discard changes to specific files, or git stash to save them.',
  },
  // git branch -D (force delete branch)
  {
    pattern: /\bgit\s+branch\s+-D\b/,
    reason:
      'git branch -D force-deletes a branch even if not fully merged, risking data loss.',
    suggestion:
      'Use git branch -d (lowercase) which only deletes fully merged branches.',
  },
];

const WARN_RULES: WarnRule[] = [
  // Force-push to non-main branches (suggest --force-with-lease)
  {
    pattern: /\bgit\s+push\s+(?:.*\s+)?(?:--force|-f)(?:\s|$)/,
    warning:
      'Force-pushing rewrites remote history and can cause data loss for collaborators.',
    suggestion: 'Use --force-with-lease instead, which is safer.',
  },
  // git commit --amend (suggest new commit)
  {
    pattern: /\bgit\s+commit\s+(?:.*\s+)?--amend\b/,
    warning:
      'Amending commits rewrites history. If this commit is already pushed, it will require a force-push.',
    suggestion:
      'Create a new commit instead unless you explicitly need to amend.',
  },
  // git rebase -i (warn about published commits)
  {
    pattern: /\bgit\s+rebase\s+(?:.*\s+)?-i\b/,
    warning:
      'Interactive rebase rewrites commit history. If these commits are published, collaborators may be affected.',
    suggestion:
      'Ensure the commits being rebased have not been pushed to a shared branch.',
  },
  // git stash drop (warn about data loss)
  {
    pattern: /\bgit\s+stash\s+drop\b/,
    warning:
      'Dropping a stash permanently discards the stashed changes and cannot be undone.',
    suggestion:
      'Verify the stash contents with git stash show before dropping.',
  },
  // --no-verify on any git command
  {
    pattern: /\bgit\s+\S+\s+(?:.*\s+)?--no-verify\b/,
    warning:
      'Skipping git hooks (--no-verify) bypasses pre-commit checks and other safeguards.',
    suggestion: 'Fix the underlying hook issue instead of bypassing it.',
  },
];

/**
 * Service that checks shell commands for dangerous git operations.
 *
 * Safety checks are enforced regardless of approval mode (even in YOLO mode).
 * Block rules prevent execution entirely; warn rules allow execution but
 * include a warning message in the output.
 */
export class GitSafetyService {
  /**
   * Check if a shell command contains a dangerous git operation.
   *
   * This method is designed to be fast (regex-based) and handles:
   * - Simple commands: `git push --force origin main`
   * - Piped commands: `echo foo | git push --force`
   * - Chained commands: `git add . && git push --force origin main`
   * - Quoted arguments are partially handled (regex operates on the raw string)
   *
   * @param command The shell command to check.
   * @returns A GitSafetyCheck result.
   */
  checkCommand(command: string): GitSafetyCheck {
    // Normalize: collapse whitespace for reliable matching
    const normalized = command.replace(/\s+/g, ' ').trim();

    // Split on common shell operators to check each sub-command
    // This handles: cmd1 && cmd2, cmd1 || cmd2, cmd1 ; cmd2, cmd1 | cmd2
    const subCommands = normalized.split(/\s*(?:&&|\|\||;|\|)\s*/);

    // Check block rules first (they override everything)
    for (const subCmd of subCommands) {
      for (const rule of BLOCK_RULES) {
        if (rule.pattern.test(subCmd)) {
          return {
            allowed: false,
            reason: rule.reason,
            suggestion: rule.suggestion,
          };
        }
      }
    }

    // Check warn rules (command is allowed but with a warning)
    for (const subCmd of subCommands) {
      for (const rule of WARN_RULES) {
        if (rule.pattern.test(subCmd)) {
          // Make sure this isn't already handled by a block rule for protected branches
          // (block rules were checked first and would have returned already)
          return {
            allowed: true,
            warning: rule.warning,
            suggestion: rule.suggestion,
          };
        }
      }
    }

    // Command is safe
    return { allowed: true };
  }

  /**
   * Returns git safety rules formatted for inclusion in the system prompt.
   * These rules guide the model's behavior even before command execution.
   */
  getGitSafetyRules(): string {
    return `
## Git Safety Rules

The following rules are strictly enforced and cannot be overridden:

- **NEVER** force-push to main or master branches.
- **NEVER** use \`git reset --hard\` unless the user explicitly requests it — it discards all uncommitted changes.
- **NEVER** use \`git clean -f\` without first running \`git clean -n\` to preview deletions.
- **NEVER** skip hooks with \`--no-verify\` — fix the underlying issue instead.
- **NEVER** use \`git branch -D\` (force delete) — use \`git branch -d\` which is safe for merged branches.
- **NEVER** discard all changes with \`git checkout .\` or \`git restore .\` — target specific files instead.
- **NEVER** amend commits unless explicitly asked — create new commits instead.
- **NEVER** auto-commit — only commit when the user asks.
- Before any destructive git operation, explain what will happen and ask for confirmation.
- Prefer \`--force-with-lease\` over \`--force\` for non-protected branches.`.trim();
  }
}

/**
 * Singleton instance for use across the application.
 */
let gitSafetyServiceInstance: GitSafetyService | undefined;

/**
 * Gets or creates the GitSafetyService singleton.
 */
export function getGitSafetyService(): GitSafetyService {
  if (!gitSafetyServiceInstance) {
    gitSafetyServiceInstance = new GitSafetyService();
  }
  return gitSafetyServiceInstance;
}
