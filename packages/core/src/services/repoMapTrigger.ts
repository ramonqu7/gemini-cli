/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Detects whether a user prompt should trigger a scoped repo map injection.
 *
 * Checks for:
 * - Path references (e.g. "src/auth/", "./services/foo.ts")
 * - Exploratory intent ("how does X work", "investigate", "explore")
 * - Structural queries ("what calls", "where is", "architecture of")
 *
 * Returns a scope to scan, or null if no trigger detected.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RepoMapScope } from './repoMapService.js';

// ---------------------------------------------------------------------------
// Trigger patterns
// ---------------------------------------------------------------------------

/** Phrases that indicate the user wants structural understanding. */
const EXPLORATORY_PATTERNS: RegExp[] = [
  /how\s+does\s+.+\s+work/i,
  /investigate\b/i,
  /explore\b/i,
  /explain\s+(?:the\s+)?(?:architecture|structure|design|layout)/i,
  /what\s+calls\b/i,
  /where\s+is\b/i,
  /what\s+imports\b/i,
  /overview\s+of\b/i,
  /walk\s+(?:me\s+)?through\b/i,
  /understand\b.*\b(?:code|module|package|service|component)/i,
  /map\s+(?:out|the)\b/i,
];

/**
 * Matches filesystem-like path references in a prompt.
 * Captures paths like `src/auth/`, `./services/foo.ts`, `packages/core`.
 * Avoids matching URLs, flag-like args, or purely numeric strings.
 */
const PATH_PATTERN =
  /(?:^|\s|['"`])(\.{0,2}\/(?:[a-zA-Z0-9_\-@.]+\/)*[a-zA-Z0-9_\-@.]+\/?)/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyzes a user prompt and returns a repo map scope if one should be
 * injected, or null if no trigger was detected.
 *
 * @param prompt     The raw user prompt text.
 * @param rootDir    The project root directory.
 */
export function detectRepoMapTrigger(
  prompt: string,
  rootDir: string,
): RepoMapScope | null {
  // 1. Try to extract an explicit path reference.
  const pathScope = extractPathScope(prompt, rootDir);
  if (pathScope) return pathScope;

  // 2. Check for exploratory intent without explicit path.
  //    In this case, try to infer a directory from the prompt context.
  if (hasExploratoryIntent(prompt)) {
    const inferredScope = inferScopeFromPrompt(prompt, rootDir);
    if (inferredScope) return inferredScope;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract a path reference from the prompt and resolve it against rootDir.
 */
function extractPathScope(
  prompt: string,
  rootDir: string,
): RepoMapScope | null {
  const matches: string[] = [];

  let match: RegExpExecArray | null;
  const re = new RegExp(PATH_PATTERN.source, PATH_PATTERN.flags);
  while ((match = re.exec(prompt)) !== null) {
    if (match[1]) {
      matches.push(match[1].trim());
    }
  }

  // Also check for unquoted bare directory-like references
  // e.g. "src/auth" without leading ./
  const barePathRe =
    /(?:^|\s)([a-zA-Z][a-zA-Z0-9_\-]*(?:\/[a-zA-Z0-9_\-@.]+)+\/?)/g;
  while ((match = barePathRe.exec(prompt)) !== null) {
    if (match[1]) {
      matches.push(match[1].trim());
    }
  }

  // Deduplicate and resolve.
  const seen = new Set<string>();
  for (const raw of matches) {
    const cleaned = raw.replace(/['"`,;:]+$/, '');
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);

    const resolved = path.resolve(rootDir, cleaned);

    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return { kind: 'directory', target: resolved };
      }
      if (stat.isFile()) {
        return { kind: 'file', target: resolved };
      }
    } catch {
      // Path doesn't exist — continue checking other matches.
    }
  }

  return null;
}

/**
 * Check if the prompt contains exploratory language.
 */
function hasExploratoryIntent(prompt: string): boolean {
  return EXPLORATORY_PATTERNS.some((re) => re.test(prompt));
}

/**
 * Try to infer a directory scope from context clues in the prompt.
 * Looks for common module/package/directory names.
 */
function inferScopeFromPrompt(
  prompt: string,
  rootDir: string,
): RepoMapScope | null {
  // Extract potential directory names from the prompt.
  // Look for quoted identifiers or capitalized module names.
  const candidates: string[] = [];

  // Match quoted strings that look like paths or module names.
  const quotedRe = /['"`]([a-zA-Z][a-zA-Z0-9_\-/]*)['"` ]/g;
  let m: RegExpExecArray | null;
  while ((m = quotedRe.exec(prompt)) !== null) {
    if (m[1]) candidates.push(m[1]);
  }

  // Match "the X module/service/package/component".
  const moduleRe =
    /the\s+(\w+)\s+(?:module|service|package|component|directory|folder|dir)/gi;
  while ((m = moduleRe.exec(prompt)) !== null) {
    if (m[1]) candidates.push(m[1]);
  }

  // Try to resolve each candidate against common project structures.
  const commonPrefixes = ['', 'src/', 'packages/', 'lib/', 'pkg/', 'internal/'];
  for (const candidate of candidates) {
    for (const prefix of commonPrefixes) {
      const tryPath = path.resolve(rootDir, prefix + candidate);
      try {
        if (fs.statSync(tryPath).isDirectory()) {
          return { kind: 'directory', target: tryPath };
        }
      } catch {
        // Not found — continue.
      }
    }
  }

  return null;
}
