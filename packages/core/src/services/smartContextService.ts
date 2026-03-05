/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

/**
 * Reason why a file was suggested as relevant context.
 */
export type RelevanceReason =
  | 'recently-edited'
  | 'import-target'
  | 'imported-by-edit'
  | 'test-file'
  | 'implementation-file'
  | 'config-file'
  | 'prompt-match';

/**
 * A file suggestion with its relevance score and reasoning.
 */
export interface ContextSuggestion {
  filePath: string;
  score: number;
  reasons: RelevanceReason[];
}

/**
 * Record of a recently edited file with timestamp.
 */
interface EditRecord {
  filePath: string;
  timestamp: number;
}

/** Maximum number of recent edits to track. */
const MAX_EDIT_HISTORY = 50;

/** Maximum number of suggestions to return. */
const MAX_SUGGESTIONS = 10;

/** How long (ms) a recent edit stays highly relevant (5 minutes). */
const RECENCY_WINDOW_MS = 5 * 60 * 1000;

/** Config file basenames to look for in the same directory as an edited file. */
const CONFIG_FILE_NAMES = new Set([
  'package.json',
  'tsconfig.json',
  'tsconfig.build.json',
  '.eslintrc.json',
  '.eslintrc.js',
  'BUILD',
  'BUILD.bazel',
  'Makefile',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
]);

/**
 * Language-specific import/require patterns.
 * Each entry returns the raw specifier string from a match (group 1).
 */
const IMPORT_PATTERNS: Array<{ extensions: Set<string>; patterns: RegExp[] }> =
  [
    {
      // TypeScript / JavaScript / JSX / TSX
      extensions: new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']),
      patterns: [
        // import ... from 'specifier'
        /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
        // import 'specifier'  (side-effect imports)
        /import\s+['"]([^'"]+)['"]/g,
        // require('specifier')
        /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        // export ... from 'specifier'
        /export\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
      ],
    },
    {
      // Python
      extensions: new Set(['.py', '.pyi']),
      patterns: [
        // from package import ...
        /from\s+([\w.]+)\s+import/g,
        // import package
        /^import\s+([\w.]+)/gm,
      ],
    },
    {
      // Go
      extensions: new Set(['.go']),
      patterns: [
        // import "package"  or  "package" inside import block
        /["']([^"']+)["']/g,
      ],
    },
  ];

/**
 * Test file patterns — maps a source file to its likely test counterpart
 * and vice-versa.
 */
const TEST_SUFFIXES: Array<{
  extensions: Set<string>;
  testPatterns: Array<{ suffix: string; replacement: string }>;
}> = [
  {
    extensions: new Set(['.ts', '.tsx', '.js', '.jsx']),
    testPatterns: [
      { suffix: '.test', replacement: '' },
      { suffix: '.spec', replacement: '' },
    ],
  },
  {
    extensions: new Set(['.py']),
    testPatterns: [{ suffix: '_test', replacement: '' }],
  },
  {
    extensions: new Set(['.go']),
    testPatterns: [{ suffix: '_test', replacement: '' }],
  },
];

/**
 * SmartContextService tracks recently edited files and suggests related files
 * that may be relevant to the user's current task. It uses lightweight,
 * regex-based import parsing and path heuristics — no file I/O is performed
 * for scoring; only path-level analysis.
 *
 * Usage:
 *   const ctx = new SmartContextService();
 *   ctx.recordFileEdit('/project/src/foo.ts');
 *   const suggestions = ctx.getSuggestedContext('fix the foo parser');
 */
export class SmartContextService {
  private editHistory: EditRecord[] = [];
  private importCache: Map<string, string[]> = new Map();

  // ------------------------------------------------------------------
  // Edit tracking
  // ------------------------------------------------------------------

  /**
   * Record that a file was just edited (written or patched).
   */
  recordFileEdit(filePath: string): void {
    const absolute = path.resolve(filePath);

    // Remove older entry for the same file so it moves to the front.
    this.editHistory = this.editHistory.filter(
      (r) => r.filePath !== absolute,
    );

    this.editHistory.unshift({ filePath: absolute, timestamp: Date.now() });

    if (this.editHistory.length > MAX_EDIT_HISTORY) {
      this.editHistory.length = MAX_EDIT_HISTORY;
    }

    // Invalidate import cache for re-written file.
    this.importCache.delete(absolute);
  }

  /**
   * Return the most recently edited files, newest first.
   */
  getRecentEdits(limit: number = 10): string[] {
    return this.editHistory.slice(0, limit).map((r) => r.filePath);
  }

  // ------------------------------------------------------------------
  // Import extraction (from raw source text)
  // ------------------------------------------------------------------

  /**
   * Extract import specifiers from source text for a given file extension.
   * Results are cached per filePath until the file is re-edited.
   *
   * @param filePath  Absolute path (used for extension detection and caching).
   * @param sourceText  The file's source code.
   * @returns  Array of raw import specifiers.
   */
  extractImports(filePath: string, sourceText: string): string[] {
    const cached = this.importCache.get(filePath);
    if (cached) return cached;

    const ext = path.extname(filePath).toLowerCase();
    const specifiers: string[] = [];

    for (const langConfig of IMPORT_PATTERNS) {
      if (!langConfig.extensions.has(ext)) continue;

      for (const pattern of langConfig.patterns) {
        // Reset lastIndex for global regexps.
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(sourceText)) !== null) {
          if (match[1]) {
            specifiers.push(match[1]);
          }
        }
      }
    }

    const unique = [...new Set(specifiers)];
    this.importCache.set(filePath, unique);
    return unique;
  }

  // ------------------------------------------------------------------
  // Related file discovery (path-based, no I/O)
  // ------------------------------------------------------------------

  /**
   * For a given source file path, return paths of likely related files.
   * This is purely path-based — it does NOT check whether files exist on disk.
   */
  findRelatedFiles(filePath: string): string[] {
    const absolute = path.resolve(filePath);
    const dir = path.dirname(absolute);
    const ext = path.extname(absolute);
    const baseName = path.basename(absolute, ext);
    const related: string[] = [];

    // 1. Test file ↔ implementation file
    for (const langConfig of TEST_SUFFIXES) {
      if (!langConfig.extensions.has(ext)) continue;

      for (const tp of langConfig.testPatterns) {
        if (baseName.endsWith(tp.suffix)) {
          // This IS a test file — suggest the implementation.
          const implName =
            baseName.slice(0, -tp.suffix.length) + tp.replacement;
          related.push(path.join(dir, implName + ext));
        } else {
          // This is an implementation file — suggest its test.
          related.push(path.join(dir, baseName + tp.suffix + ext));
        }
      }
    }

    // 2. Config files in the same directory.
    for (const configName of CONFIG_FILE_NAMES) {
      related.push(path.join(dir, configName));
    }

    return related;
  }

  // ------------------------------------------------------------------
  // Relevance scoring
  // ------------------------------------------------------------------

  /**
   * Score how relevant a file path is to the current user prompt.
   * Returns a value between 0.0 and 1.0.
   *
   * Scoring factors:
   *   - File name contains words from the prompt  (up to 0.4)
   *   - File was recently edited                  (up to 0.3)
   *   - File is imported by a recently edited file (0.2)
   *   - File is a test/impl counterpart of an edit (0.1)
   */
  scoreRelevance(
    filePath: string,
    userPrompt: string,
    recentEditSet?: Set<string>,
    importedByEdits?: Set<string>,
  ): number {
    let score = 0;
    const absolute = path.resolve(filePath);
    const fileName = path.basename(absolute).toLowerCase();

    // --- Prompt keyword matching (max 0.4) ---
    const words = tokenizePrompt(userPrompt);
    if (words.length > 0) {
      let matchCount = 0;
      for (const word of words) {
        if (fileName.includes(word)) {
          matchCount++;
        }
      }
      score += Math.min(0.4, (matchCount / words.length) * 0.4);
    }

    // --- Recency boost (max 0.3) ---
    const editRecord = this.editHistory.find((r) => r.filePath === absolute);
    if (editRecord) {
      const age = Date.now() - editRecord.timestamp;
      if (age < RECENCY_WINDOW_MS) {
        // Linear decay within the recency window.
        score += 0.3 * (1 - age / RECENCY_WINDOW_MS);
      } else {
        score += 0.1; // Still a small boost for older edits.
      }
    }

    // --- Imported by a recent edit (0.2) ---
    if (importedByEdits?.has(absolute)) {
      score += 0.2;
    }

    // --- Recent edit set membership (for test/impl counterpart) ---
    if (recentEditSet) {
      const relatedPaths = this.findRelatedFiles(absolute);
      for (const rel of relatedPaths) {
        if (recentEditSet.has(rel)) {
          score += 0.1;
          break;
        }
      }
    }

    return Math.min(1.0, score);
  }

  // ------------------------------------------------------------------
  // Top-level suggestion API
  // ------------------------------------------------------------------

  /**
   * Return the top N most relevant file paths for the user's prompt,
   * based on recent edits and path-level heuristics.
   */
  getSuggestedContext(
    userPrompt: string,
    maxFiles: number = MAX_SUGGESTIONS,
  ): ContextSuggestion[] {
    const candidates = new Map<string, ContextSuggestion>();
    const recentEdits = this.getRecentEdits(20);
    const recentEditSet = new Set(recentEdits);

    // Collect all import targets from cached imports of recent edits.
    const importedByEdits = new Set<string>();
    for (const editPath of recentEdits) {
      const imports = this.importCache.get(editPath) ?? [];
      for (const spec of imports) {
        // Resolve relative specifiers against the edited file's directory.
        if (spec.startsWith('.')) {
          const resolved = resolveRelativeImport(editPath, spec);
          if (resolved) importedByEdits.add(resolved);
        }
      }
    }

    // Seed candidates from recent edits and their related files.
    for (const editPath of recentEdits) {
      addCandidate(candidates, editPath, 'recently-edited');

      const related = this.findRelatedFiles(editPath);
      for (const rel of related) {
        if (CONFIG_FILE_NAMES.has(path.basename(rel))) {
          addCandidate(candidates, rel, 'config-file');
        } else if (isTestFile(rel)) {
          addCandidate(candidates, rel, 'test-file');
        } else {
          addCandidate(candidates, rel, 'implementation-file');
        }
      }

      // Add cached import targets.
      const imports = this.importCache.get(editPath) ?? [];
      for (const spec of imports) {
        if (spec.startsWith('.')) {
          const resolved = resolveRelativeImport(editPath, spec);
          if (resolved) {
            addCandidate(candidates, resolved, 'import-target');
          }
        }
      }
    }

    // Score all candidates.
    for (const suggestion of candidates.values()) {
      suggestion.score = this.scoreRelevance(
        suggestion.filePath,
        userPrompt,
        recentEditSet,
        importedByEdits,
      );

      // Boost based on reason types.
      if (suggestion.reasons.includes('recently-edited')) {
        suggestion.score = Math.min(1.0, suggestion.score + 0.05);
      }
      if (suggestion.reasons.includes('prompt-match')) {
        suggestion.score = Math.min(1.0, suggestion.score + 0.05);
      }
    }

    // Check prompt-match for all candidates.
    const promptWords = tokenizePrompt(userPrompt);
    for (const suggestion of candidates.values()) {
      const fileName = path.basename(suggestion.filePath).toLowerCase();
      for (const word of promptWords) {
        if (fileName.includes(word)) {
          if (!suggestion.reasons.includes('prompt-match')) {
            suggestion.reasons.push('prompt-match');
          }
          break;
        }
      }
    }

    // Sort by score descending, take top N.
    const sorted = [...candidates.values()]
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxFiles);

    return sorted;
  }

  /**
   * Format the suggestions into a human-readable prompt snippet.
   */
  formatContextSuggestion(suggestions?: ContextSuggestion[]): string {
    const items = suggestions ?? this.getSuggestedContext('');
    if (items.length === 0) return '';

    const lines = items.map((s) => {
      const reasons = s.reasons.map(formatReason).join(', ');
      const relativePath = s.filePath;
      return `  - ${relativePath} (${reasons})`;
    });

    return `Related files you may want to review:\n${lines.join('\n')}`;
  }

  /**
   * Reset all tracked state (useful for testing or session boundaries).
   */
  reset(): void {
    this.editHistory = [];
    this.importCache.clear();
  }
}

// ====================================================================
// Helper functions
// ====================================================================

/**
 * Tokenize a user prompt into lowercase words suitable for matching
 * against file names. Filters out very short or common words.
 */
function tokenizePrompt(prompt: string): string[] {
  const STOP_WORDS = new Set([
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'can',
    'shall',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'at',
    'by',
    'from',
    'as',
    'into',
    'through',
    'about',
    'up',
    'out',
    'and',
    'but',
    'or',
    'not',
    'no',
    'if',
    'then',
    'else',
    'when',
    'how',
    'what',
    'which',
    'who',
    'where',
    'why',
    'all',
    'each',
    'every',
    'both',
    'few',
    'more',
    'most',
    'other',
    'some',
    'such',
    'only',
    'own',
    'same',
    'so',
    'than',
    'too',
    'very',
    'just',
    'it',
    'its',
    'this',
    'that',
    'these',
    'those',
    'my',
    'your',
    'his',
    'her',
    'our',
    'their',
    'me',
    'him',
    'us',
    'them',
    'i',
    'you',
    'he',
    'she',
    'we',
    'they',
    'file',
    'files',
    'code',
    'fix',
    'add',
    'update',
    'change',
    'make',
    'look',
    'check',
    'find',
    'get',
    'set',
    'use',
    'new',
    'please',
  ]);

  return prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

/**
 * Add or merge a candidate into the suggestions map.
 */
function addCandidate(
  map: Map<string, ContextSuggestion>,
  filePath: string,
  reason: RelevanceReason,
): void {
  const existing = map.get(filePath);
  if (existing) {
    if (!existing.reasons.includes(reason)) {
      existing.reasons.push(reason);
    }
  } else {
    map.set(filePath, { filePath, score: 0, reasons: [reason] });
  }
}

/**
 * Resolve a relative import specifier against a source file's directory.
 * Handles common JS/TS extension conventions.
 */
function resolveRelativeImport(
  sourceFile: string,
  specifier: string,
): string | null {
  const dir = path.dirname(sourceFile);
  let resolved = path.resolve(dir, specifier);

  // If the specifier already has an extension, use it as-is.
  if (path.extname(resolved)) {
    // Strip .js extension and try .ts (common in TS projects with .js imports).
    if (resolved.endsWith('.js')) {
      return resolved.replace(/\.js$/, '.ts');
    }
    return resolved;
  }

  // Try adding the same extension as the source file.
  const sourceExt = path.extname(sourceFile);
  if (sourceExt) {
    resolved = resolved + sourceExt;
  }

  return resolved;
}

/**
 * Check if a file path looks like a test file.
 */
function isTestFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return (
    base.includes('.test.') ||
    base.includes('.spec.') ||
    base.includes('_test.') ||
    base.startsWith('test_')
  );
}

/**
 * Human-readable label for a relevance reason.
 */
function formatReason(reason: RelevanceReason): string {
  switch (reason) {
    case 'recently-edited':
      return 'recently edited';
    case 'import-target':
      return 'imported by edited file';
    case 'imported-by-edit':
      return 'imports edited file';
    case 'test-file':
      return 'test for edited file';
    case 'implementation-file':
      return 'implementation for test';
    case 'config-file':
      return 'config in same directory';
    case 'prompt-match':
      return 'matches prompt keywords';
    default:
      return reason;
  }
}
