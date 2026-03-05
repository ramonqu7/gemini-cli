/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { debugLogger } from '../utils/debugLogger.js';

/**
 * Task complexity levels used to determine the appropriate thinking budget.
 */
export type TaskComplexity = 'simple' | 'moderate' | 'complex' | 'deep';

/**
 * The thinking budget (in tokens) assigned to each complexity level.
 */
const COMPLEXITY_BUDGETS: Record<TaskComplexity, number> = {
  simple: 1024,
  moderate: 4096,
  complex: 8192,
  deep: 16384,
};

/**
 * Default budgets for known subagent roles.
 */
const SUBAGENT_BUDGETS: Record<string, number> = {
  researcher: COMPLEXITY_BUDGETS.moderate,
  explorer: COMPLEXITY_BUDGETS.moderate,
  worker: COMPLEXITY_BUDGETS.complex,
  implementer: COMPLEXITY_BUDGETS.complex,
  reviewer: COMPLEXITY_BUDGETS.complex,
};

// Patterns that indicate simple tasks (case-insensitive matching).
const SIMPLE_PATTERNS: RegExp[] = [
  /^what\s+(is|are|does|was)\b/i,
  /^how\s+(do|does|to|can|should)\b/i,
  /^(show|list|print|display|read|get|find)\s/i,
  /^(explain|describe|summarize|tell me about)\b/i,
  /\?$/,
];

// Keywords that indicate moderate complexity.
const MODERATE_KEYWORDS: string[] = [
  'add',
  'change',
  'update',
  'fix',
  'modify',
  'edit',
  'rename',
  'move',
  'create',
  'remove',
  'delete',
  'replace',
  'implement',
  'write',
  'set',
  'configure',
];

// Keywords that indicate complex tasks.
const COMPLEX_KEYWORDS: string[] = [
  'debug',
  'refactor',
  'investigate',
  'why',
  'architecture',
  'integrate',
  'optimize',
  'test',
  'troubleshoot',
  'diagnose',
  'analyze',
  'trace',
  'review',
  'multi-file',
  'across',
  'multiple files',
  'multiple directories',
];

// Keywords that indicate deep/system-level tasks.
const DEEP_KEYWORDS: string[] = [
  'design',
  'migrate',
  'rewrite',
  'performance',
  'security audit',
  'system design',
  'scalability',
  'migration',
  'overhaul',
  're-architect',
  'benchmark',
  'comprehensive',
  'end-to-end',
  'full-stack',
];

// Regex to detect file/directory path references.
// Matches paths like /foo/bar/baz or src/config.ts but not standalone
// technology names like "Node.js" or "TypeScript.org".
const PATH_REFERENCE_PATTERN =
  /(?:\/[\w.-]+){2,}|[\w-]+\/[\w.-]+(?:\/[\w.-]+)*|[\w-]+\.\w{2,5}\b/g;

// Known technology/product name patterns that look like file paths but aren't.
const FALSE_PATH_NAMES = new Set([
  'node.js',
  'next.js',
  'vue.js',
  'react.js',
  'angular.js',
  'express.js',
  'nest.js',
  'nuxt.js',
  'deno.js',
  'bun.js',
]);

/**
 * Counts how many keywords from a list appear in the prompt.
 * Uses word-start boundary matching so that "debug" also matches
 * "debugging", "debugger", etc.
 */
function countKeywordHits(promptLower: string, keywords: string[]): number {
  let count = 0;
  for (const keyword of keywords) {
    // For multi-word keywords, check for substring match.
    // For single-word keywords, use word-start boundary to allow
    // inflected forms (e.g., "debug" matches "debugging").
    if (keyword.includes(' ')) {
      if (promptLower.includes(keyword)) {
        count++;
      }
    } else {
      const regex = new RegExp(`\\b${keyword}`, 'i');
      if (regex.test(promptLower)) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Service that dynamically adjusts the Gemini thinking budget based on
 * task complexity. Classification is done via fast heuristics (no LLM calls).
 */
export class ThinkingBudgetService {
  /**
   * Classifies the complexity of a task from the user prompt.
   *
   * @param userPrompt - The raw user prompt text.
   * @param recentContext - Optional recent conversation context for
   *   additional signal.
   * @returns The classified task complexity level.
   */
  classifyComplexity(
    userPrompt: string,
    recentContext?: string,
  ): TaskComplexity {
    const prompt = userPrompt.trim();
    const promptLower = prompt.toLowerCase();

    // Word count for length-based heuristics.
    const wordCount = prompt.split(/\s+/).filter((w) => w.length > 0).length;

    // Count file/path references as a complexity signal, filtering out
    // known technology names that look like file paths.
    const pathMatches = (prompt.match(PATH_REFERENCE_PATTERN) || []).filter(
      (m) => !FALSE_PATH_NAMES.has(m.toLowerCase()),
    );
    const pathCount = pathMatches.length;

    // Combine prompt and context for keyword matching when context is present.
    const fullTextLower = recentContext
      ? `${promptLower} ${recentContext.toLowerCase()}`
      : promptLower;

    // Score each complexity level using full text (prompt + optional context).
    const deepHits = countKeywordHits(fullTextLower, DEEP_KEYWORDS);
    const complexHits = countKeywordHits(fullTextLower, COMPLEX_KEYWORDS);
    const moderateHits = countKeywordHits(fullTextLower, MODERATE_KEYWORDS);

    // Also score against the prompt alone to distinguish "questions about
    // actions" from "action instructions". For example, "How do I install
    // Node.js?" contains "install" but is clearly a question, not a task.
    const promptComplexHits = countKeywordHits(promptLower, COMPLEX_KEYWORDS);

    // Check for simple patterns (short prompts with question-like structure).
    const matchesSimplePattern = SIMPLE_PATTERNS.some((p) => p.test(prompt));

    // Deep: strong signals or very long prompts.
    if (deepHits >= 2 || (deepHits >= 1 && wordCount > 200)) {
      return 'deep';
    }

    // Complex: multiple complex signals, complex + paths, complex + moderate length,
    // or moderate action on multiple paths (cross-file changes).
    if (
      complexHits >= 2 ||
      (complexHits >= 1 && pathCount >= 2) ||
      (complexHits >= 1 && wordCount > 100) ||
      (promptComplexHits >= 1 && wordCount > 5) ||
      (moderateHits >= 1 && pathCount >= 2)
    ) {
      return 'complex';
    }

    // Simple: short prompts matching a question pattern, but only if
    // there are no path references. When a prompt is clearly a question
    // (matching a simple pattern) and is short, action keywords like
    // "install" are part of the question itself, not task instructions.
    if (matchesSimplePattern && pathCount === 0 && wordCount <= 20) {
      return 'simple';
    }

    // Moderate: action keywords or file references.
    if (
      moderateHits >= 1 ||
      pathCount >= 1 ||
      (wordCount > 50 && !matchesSimplePattern)
    ) {
      return 'moderate';
    }

    // Simple: short prompts with no action signals.
    if (matchesSimplePattern || wordCount < 50) {
      return 'simple';
    }

    // Default fallback.
    return 'moderate';
  }

  /**
   * Returns the recommended thinking budget (in tokens) for a given
   * complexity level.
   *
   * @param complexity - The task complexity level.
   * @returns The thinking budget in tokens.
   */
  getBudget(complexity: TaskComplexity): number {
    return COMPLEXITY_BUDGETS[complexity];
  }

  /**
   * Returns the recommended thinking budget for a subagent based on its role.
   * Falls back to the 'complex' budget for unknown roles.
   *
   * @param agentRole - The role identifier of the subagent
   *   (e.g., 'researcher', 'worker').
   * @returns The thinking budget in tokens.
   */
  getBudgetForSubagent(agentRole: string): number {
    const roleLower = agentRole.toLowerCase();
    return SUBAGENT_BUDGETS[roleLower] ?? COMPLEXITY_BUDGETS.complex;
  }

  /**
   * Classifies complexity and returns the recommended budget, logging the
   * decision for debugging. This is the primary entry point for integration.
   *
   * @param userPrompt - The raw user prompt text.
   * @param recentContext - Optional recent conversation context.
   * @returns An object with the complexity classification and budget.
   */
  recommendBudget(
    userPrompt: string,
    recentContext?: string,
  ): { complexity: TaskComplexity; budget: number } {
    const complexity = this.classifyComplexity(userPrompt, recentContext);
    const budget = this.getBudget(complexity);
    debugLogger.debug(
      `[ThinkingBudget] Classified complexity="${complexity}" budget=${budget} (prompt length=${userPrompt.length} chars)`,
    );
    return { complexity, budget };
  }
}
