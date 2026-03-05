/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { glob } from 'glob';
import { debugLogger } from '../utils/debugLogger.js';
import { BINARY_EXTENSIONS } from '../utils/ignorePatterns.js';
import { SmartContextService } from './smartContextService.js';

/** Maximum number of files to pre-fetch in a single batch. */
const MAX_PREFETCH_FILES = 20;

/** Maximum total bytes to cache (1 MB). */
const MAX_TOTAL_BYTES = 1 * 1024 * 1024;

/** Extensions that should never be pre-fetched. */
const BINARY_EXT_SET = new Set(BINARY_EXTENSIONS);

/**
 * Result of pre-fetching a single file.
 */
export interface PrefetchResult {
  /** Absolute path to the file. */
  path: string;
  /** File content, or null if the read failed. */
  content: string | null;
  /** Error message if the read failed. */
  error?: string;
  /** Number of lines in the file (if read successfully). */
  lineCount?: number;
}

/**
 * Cache hit/miss statistics for observability.
 */
export interface PrefetchStats {
  /** Number of cache hits (file was pre-fetched and served from cache). */
  hits: number;
  /** Number of cache misses (file was not in cache). */
  misses: number;
  /** Number of files that were pre-fetched in the latest batch. */
  prefetched: number;
}

/**
 * Regex to match file-path-like strings in user prompts.
 *
 * Matches things like:
 *   src/auth/login.ts
 *   ./packages/core/index.js
 *   ../utils/helpers.py
 *   /absolute/path/to/file.go
 */
const FILE_PATH_REGEX =
  /(?:^|[\s'"(`])([.]{0,2}\/[\w./-]+\.\w{1,10}|[\w][\w./-]*\/[\w./-]+\.\w{1,10})/g;

/**
 * Regex to match directory-like references in user prompts.
 *
 * Matches things like:
 *   src/auth/
 *   ./packages/core/
 *   src/auth  (followed by space or end, with at least one slash)
 */
const DIR_PATH_REGEX =
  /(?:^|[\s'"(`])([.]{0,2}\/[\w./-]+\/|[\w][\w./-]*\/[\w./-]*\/?)(?=[\s'")`]|$)/g;

/**
 * PrefetchService speculatively reads files that the model is likely
 * to request, based on heuristic analysis of the user's prompt.
 *
 * It runs as a non-blocking, fire-and-forget task at the start of each
 * user turn, then serves cached content when the read_file tool is
 * invoked — turning sequential tool calls into instant cache hits.
 *
 * Usage:
 *   const prefetch = new PrefetchService(smartContextService);
 *
 *   // Fire at start of user turn (non-blocking)
 *   prefetch.prefetch(userPrompt, workingDir);
 *
 *   // In read_file tool:
 *   const cached = prefetch.getCached('/abs/path/to/file.ts');
 *   if (cached) return cached.content;
 */
export class PrefetchService {
  private cache: Map<string, PrefetchResult> = new Map();
  private hits = 0;
  private misses = 0;
  private totalPrefetched = 0;
  private prefetchPromise: Promise<void> | null = null;

  constructor(private readonly smartContext?: SmartContextService) {}

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Predict and pre-fetch files based on the user's prompt.
   *
   * This method is designed to be called as fire-and-forget:
   *   prefetchService.prefetch(prompt, cwd);  // no await needed
   *
   * Internally it stores the promise so getCached() can optionally
   * wait for it, but the caller should never block on it.
   */
  async prefetch(userPrompt: string, workingDir: string): Promise<void> {
    // Clear previous cache for the new prompt.
    this.clearCache();

    const predicted = await this.predictFiles(userPrompt, workingDir);

    if (predicted.length === 0) {
      return;
    }

    debugLogger.debug(
      `[Prefetch] Predicted ${predicted.length} files to pre-fetch`,
    );

    this.prefetchPromise = this.readAllParallel(predicted);

    // The promise is stored but we don't await it here — the caller
    // fires this as non-blocking. We do catch errors to avoid
    // unhandled rejections.
    this.prefetchPromise.catch((err) => {
      debugLogger.warn(`[Prefetch] Background pre-fetch failed: ${err}`);
    });
  }

  /**
   * Check if a file is available in the prefetch cache.
   *
   * @returns The cached result, or null if the file was not pre-fetched.
   */
  getCached(filePath: string): PrefetchResult | null {
    const absolute = path.resolve(filePath);
    const result = this.cache.get(absolute);

    if (result) {
      this.hits++;
      debugLogger.debug(`[Prefetch] Cache HIT: ${absolute}`);
      return result;
    }

    this.misses++;
    return null;
  }

  /**
   * Add a file to the cache after a normal (non-prefetched) read.
   * This allows subsequent reads of the same file within one turn
   * to be served from cache.
   */
  addToCache(filePath: string, content: string): void {
    const absolute = path.resolve(filePath);
    if (this.cache.has(absolute)) {
      return; // Already cached.
    }

    const lineCount = content.split('\n').length;
    this.cache.set(absolute, { path: absolute, content, lineCount });
  }

  /**
   * Clear the entire cache. Called at the start of each new user prompt.
   */
  clearCache(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.totalPrefetched = 0;
    this.prefetchPromise = null;
  }

  /**
   * Return cache hit/miss statistics for debugging.
   */
  getStats(): PrefetchStats {
    return {
      hits: this.hits,
      misses: this.misses,
      prefetched: this.totalPrefetched,
    };
  }

  // ------------------------------------------------------------------
  // Prediction heuristics
  // ------------------------------------------------------------------

  /**
   * Analyze the user prompt and predict which files the model will need.
   *
   * Heuristic layers (no LLM call):
   *   1. Extract explicit file paths from the prompt text.
   *   2. Extract directory references -> glob for files in those dirs.
   *   3. For each predicted file, add its test/impl counterpart
   *      (via SmartContextService.findRelatedFiles).
   *   4. Add recently edited files from SmartContextService.
   *
   * Results are de-duplicated and capped at MAX_PREFETCH_FILES.
   */
  private async predictFiles(
    userPrompt: string,
    workingDir: string,
  ): Promise<string[]> {
    const candidates = new Set<string>();

    // 1. Extract explicit file paths mentioned in the prompt.
    const mentionedFiles = this.extractFilePaths(userPrompt, workingDir);
    for (const f of mentionedFiles) {
      candidates.add(f);
    }

    // 2. Extract directory references and glob for files.
    const mentionedDirs = this.extractDirectories(userPrompt, workingDir);
    for (const dir of mentionedDirs) {
      const filesInDir = await this.globDirectory(dir);
      for (const f of filesInDir) {
        candidates.add(f);
        if (candidates.size >= MAX_PREFETCH_FILES) break;
      }
      if (candidates.size >= MAX_PREFETCH_FILES) break;
    }

    // 3. For each candidate so far, add related files (test <-> impl).
    if (this.smartContext) {
      const currentCandidates = [...candidates];
      for (const filePath of currentCandidates) {
        if (candidates.size >= MAX_PREFETCH_FILES) break;
        const related = this.smartContext.findRelatedFiles(filePath);
        for (const rel of related) {
          if (candidates.size >= MAX_PREFETCH_FILES) break;
          // Only add non-config related files (test/impl counterparts).
          if (!rel.includes('package.json') && !rel.includes('tsconfig')) {
            candidates.add(rel);
          }
        }
      }
    }

    // 4. Add recently edited files.
    if (this.smartContext) {
      const recentEdits = this.smartContext.getRecentEdits(5);
      for (const edit of recentEdits) {
        if (candidates.size >= MAX_PREFETCH_FILES) break;
        candidates.add(edit);
      }
    }

    // Filter out binary files and non-existent paths.
    const filtered = [...candidates].filter(
      (f) => !this.isBinaryExtension(f),
    );

    return filtered.slice(0, MAX_PREFETCH_FILES);
  }

  /**
   * Extract file paths mentioned in the user prompt.
   */
  private extractFilePaths(prompt: string, workingDir: string): string[] {
    const paths: string[] = [];
    FILE_PATH_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = FILE_PATH_REGEX.exec(prompt)) !== null) {
      const rawPath = match[1];
      if (rawPath) {
        const resolved = path.resolve(workingDir, rawPath);
        paths.push(resolved);
      }
    }

    return paths;
  }

  /**
   * Extract directory-like references from the user prompt.
   */
  private extractDirectories(prompt: string, workingDir: string): string[] {
    const dirs: string[] = [];
    DIR_PATH_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = DIR_PATH_REGEX.exec(prompt)) !== null) {
      const rawDir = match[1];
      if (rawDir) {
        const resolved = path.resolve(workingDir, rawDir);
        dirs.push(resolved);
      }
    }

    return dirs;
  }

  /**
   * Glob a directory for source files (non-recursive, top-level only).
   * Caps results to avoid pulling in hundreds of files from large dirs.
   */
  private async globDirectory(dirPath: string): Promise<string[]> {
    try {
      const stat = await fsPromises.stat(dirPath);
      if (!stat.isDirectory()) {
        return [];
      }
    } catch {
      return []; // Directory doesn't exist.
    }

    try {
      const pattern = path.join(dirPath, '*');
      const matches = await glob(pattern, {
        nodir: true,
        absolute: true,
        ignore: ['**/node_modules/**', '**/.git/**'],
      });

      // Filter out binary files and cap at a reasonable number.
      return matches
        .filter((f) => !this.isBinaryExtension(f))
        .slice(0, 10);
    } catch {
      return [];
    }
  }

  // ------------------------------------------------------------------
  // File reading
  // ------------------------------------------------------------------

  /**
   * Read all predicted files in parallel, respecting the total byte cap.
   */
  private async readAllParallel(filePaths: string[]): Promise<void> {
    const results = await Promise.allSettled(
      filePaths.map((fp) => this.readSingleFile(fp)),
    );

    let totalBytes = 0;

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        const { path: filePath, content } = result.value;

        if (content !== null) {
          const contentBytes = Buffer.byteLength(content, 'utf-8');

          if (totalBytes + contentBytes > MAX_TOTAL_BYTES) {
            debugLogger.debug(
              `[Prefetch] Byte limit reached (${totalBytes}/${MAX_TOTAL_BYTES}), ` +
                `skipping ${filePath}`,
            );
            continue;
          }

          totalBytes += contentBytes;
        }

        this.cache.set(filePath, result.value);
        this.totalPrefetched++;
      }
    }

    debugLogger.debug(
      `[Prefetch] Cached ${this.totalPrefetched} files (${(totalBytes / 1024).toFixed(1)} KB)`,
    );
  }

  /**
   * Read a single file safely, returning a PrefetchResult.
   */
  private async readSingleFile(filePath: string): Promise<PrefetchResult> {
    try {
      // Quick existence + type check.
      const stat = await fsPromises.stat(filePath);

      if (stat.isDirectory()) {
        return { path: filePath, content: null, error: 'Is a directory' };
      }

      // Skip very large files (> 500 KB for prefetch purposes).
      if (stat.size > 500 * 1024) {
        return {
          path: filePath,
          content: null,
          error: `File too large for prefetch: ${(stat.size / 1024).toFixed(0)} KB`,
        };
      }

      const content = await fsPromises.readFile(filePath, 'utf-8');
      const lineCount = content.split('\n').length;

      return { path: filePath, content, lineCount };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown read error';
      return { path: filePath, content: null, error: message };
    }
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /**
   * Check if a file path has a binary extension.
   */
  private isBinaryExtension(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return BINARY_EXT_SET.has(ext);
  }
}
