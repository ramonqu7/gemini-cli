/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { debugLogger } from '../utils/debugLogger.js';
import { isSafeRegExp } from '../policy/utils.js';
import { SHELL_TOOL_NAMES } from '../utils/shell-utils.js';

/**
 * A user-facing permission rule for a specific tool.
 * Users configure these in settings.json under tools.permissions.
 */
export interface ToolPermissionRule {
  /** Tool name to match. Use '*' to match all tools. */
  tool: string;
  /**
   * Regex patterns to auto-approve.
   * For shell: patterns match against the command string.
   * For edit/write_file: patterns match against the file_path.
   */
  allow?: string[];
  /**
   * Regex patterns to always deny.
   * For shell: patterns match against the command string.
   * For edit/write_file: patterns match against the file_path.
   */
  deny?: string[];
}

export type ToolPermissionDecision = 'allow' | 'deny' | 'ask';

interface CompiledRule {
  tool: string;
  allowPatterns: RegExp[];
  denyPatterns: RegExp[];
}

/**
 * Mapping of tool names to the argument key that should be matched
 * against permission patterns.
 */
const TOOL_MATCHABLE_ARGS: Record<string, string> = {
  run_shell_command: 'command',
  ShellTool: 'command',
  replace: 'file_path',
  write_file: 'file_path',
  read_file: 'file_path',
  glob: 'pattern',
};

/**
 * Service that evaluates per-tool permission rules with regex pattern matching.
 *
 * Rules are evaluated with deny-first semantics:
 * 1. First matching deny pattern wins (returns 'deny')
 * 2. Then first matching allow pattern wins (returns 'allow')
 * 3. If no patterns match, returns 'ask' (fall back to current approval mode)
 *
 * Deny rules are enforced even in YOLO mode as a safety net.
 * Invalid regex patterns are warned about and skipped.
 * Regex objects are compiled once at construction time and cached.
 */
export class ToolPermissionService {
  private readonly compiledRules: CompiledRule[];

  constructor(rules: ToolPermissionRule[]) {
    this.compiledRules = [];
    for (const rule of rules) {
      const compiled = this.compileRule(rule);
      if (compiled) {
        this.compiledRules.push(compiled);
      }
    }
  }

  /**
   * Check if a specific tool call should be auto-approved, denied, or asked.
   *
   * @param toolName The name of the tool being invoked.
   * @param args The arguments passed to the tool.
   * @returns 'allow' if auto-approved, 'deny' if blocked, 'ask' if no rule matches.
   */
  checkPermission(
    toolName: string,
    args: Record<string, unknown>,
  ): ToolPermissionDecision {
    const matchableArg = this.getMatchableArg(toolName, args);

    // Normalize shell tool names so rules for 'shell' match both variants
    const normalizedToolName = SHELL_TOOL_NAMES.includes(toolName)
      ? 'run_shell_command'
      : toolName;

    for (const rule of this.compiledRules) {
      if (!this.toolNameMatches(rule.tool, normalizedToolName, toolName)) {
        continue;
      }

      // If no matchable arg, deny patterns with no patterns still don't match,
      // but allow rules with no patterns would match.
      // However, if there ARE patterns but no matchable arg, skip this rule.
      if (matchableArg === null) {
        // Rules with patterns require a matchable arg
        if (rule.denyPatterns.length > 0 || rule.allowPatterns.length > 0) {
          continue;
        }
        // Rule with no patterns matches any invocation of this tool
        // No patterns means no explicit decision, so fall through
        continue;
      }

      // Check deny patterns first (deny wins)
      for (const pattern of rule.denyPatterns) {
        if (pattern.test(matchableArg)) {
          debugLogger.debug(
            `[ToolPermissionService] DENY: tool=${toolName}, arg=${matchableArg}, pattern=${pattern.source}`,
          );
          return 'deny';
        }
      }

      // Check allow patterns
      for (const pattern of rule.allowPatterns) {
        if (pattern.test(matchableArg)) {
          debugLogger.debug(
            `[ToolPermissionService] ALLOW: tool=${toolName}, arg=${matchableArg}, pattern=${pattern.source}`,
          );
          return 'allow';
        }
      }
    }

    return 'ask';
  }

  /**
   * Get the relevant argument value to match patterns against.
   *
   * @param toolName The name of the tool.
   * @param args The tool arguments.
   * @returns The string value to match against, or null if not applicable.
   */
  getMatchableArg(
    toolName: string,
    args: Record<string, unknown>,
  ): string | null {
    // Check direct tool name mapping
    const argKey = TOOL_MATCHABLE_ARGS[toolName];
    if (argKey && typeof args[argKey] === 'string') {
      return args[argKey] as string;
    }

    // For tools not in the mapping, try common argument names
    if (typeof args['command'] === 'string') {
      return args['command'] as string;
    }
    if (typeof args['file_path'] === 'string') {
      return args['file_path'] as string;
    }

    return null;
  }

  /**
   * Returns the number of compiled rules.
   */
  getRuleCount(): number {
    return this.compiledRules.length;
  }

  /**
   * Check if a tool name matches a rule's tool specifier.
   */
  private toolNameMatches(
    ruleToolName: string,
    normalizedToolName: string,
    originalToolName: string,
  ): boolean {
    if (ruleToolName === '*') {
      return true;
    }

    // Direct match
    if (
      ruleToolName === normalizedToolName ||
      ruleToolName === originalToolName
    ) {
      return true;
    }

    // Alias match for shell tools
    if (
      SHELL_TOOL_NAMES.includes(ruleToolName) &&
      SHELL_TOOL_NAMES.includes(normalizedToolName)
    ) {
      return true;
    }

    return false;
  }

  /**
   * Compile a user-facing rule into cached RegExp objects.
   * Returns null if the rule has no valid patterns.
   */
  private compileRule(rule: ToolPermissionRule): CompiledRule | null {
    const allowPatterns: RegExp[] = [];
    const denyPatterns: RegExp[] = [];

    if (rule.allow) {
      for (const pattern of rule.allow) {
        const compiled = this.safeCompileRegex(pattern, rule.tool, 'allow');
        if (compiled) {
          allowPatterns.push(compiled);
        }
      }
    }

    if (rule.deny) {
      for (const pattern of rule.deny) {
        const compiled = this.safeCompileRegex(pattern, rule.tool, 'deny');
        if (compiled) {
          denyPatterns.push(compiled);
        }
      }
    }

    // Only include rules that have at least one valid pattern
    if (allowPatterns.length === 0 && denyPatterns.length === 0) {
      return null;
    }

    return {
      tool: rule.tool,
      allowPatterns,
      denyPatterns,
    };
  }

  /**
   * Safely compile a regex pattern, logging warnings for invalid patterns.
   */
  private safeCompileRegex(
    pattern: string,
    toolName: string,
    type: 'allow' | 'deny',
  ): RegExp | null {
    if (!isSafeRegExp(pattern)) {
      debugLogger.warn(
        `[ToolPermissionService] Skipping unsafe/invalid ${type} pattern for tool "${toolName}": ${pattern}`,
      );
      return null;
    }

    try {
      return new RegExp(pattern);
    } catch (error) {
      debugLogger.warn(
        `[ToolPermissionService] Failed to compile ${type} regex for tool "${toolName}": ${pattern}`,
        error,
      );
      return null;
    }
  }
}
