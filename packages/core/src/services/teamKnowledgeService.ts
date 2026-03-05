/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { debugLogger } from '../utils/debugLogger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TeamKnowledgeCategory =
  | 'playbook-correction'
  | 'investigation-pattern'
  | 'common-fix'
  | 'best-practice';

export interface TeamKnowledgeEntry {
  id: string;
  author: string;
  timestamp: number;
  category: TeamKnowledgeCategory;
  title: string;
  content: string; // Max 500 chars
  tags: string[]; // e.g., ["bq-wlm", "quota", "oncall"]
  upvotes: number;
}

export interface TeamKnowledgeStats {
  totalEntries: number;
  entriesThisWeek: number;
  topContributors: Array<{ author: string; count: number }>;
  categoryCounts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONTENT_LENGTH = 500;
const MAX_CONTEXT_BYTES = 1024;
const PRUNE_AGE_DAYS = 180;
const MAX_ENTRIES_PER_FILE = 1000;

/** JSONL filenames per category. */
const CATEGORY_FILES: Record<TeamKnowledgeCategory, string> = {
  'playbook-correction': 'playbook-corrections.jsonl',
  'investigation-pattern': 'investigation-patterns.jsonl',
  'common-fix': 'common-fixes.jsonl',
  'best-practice': 'best-practices.jsonl',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomBytes(8).toString('hex');
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

async function appendJsonlFile<T>(filePath: string, entry: T): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(filePath, line, 'utf-8');
}

async function isWritable(dirPath: string): Promise<boolean> {
  try {
    await fs.access(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function truncateToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.length <= maxBytes) return text;

  const decoded = new TextDecoder().decode(encoded.slice(0, maxBytes));
  const lastNewline = decoded.lastIndexOf('\n');
  return lastNewline > 0 ? decoded.slice(0, lastNewline) : decoded;
}

// ---------------------------------------------------------------------------
// TeamKnowledgeService
// ---------------------------------------------------------------------------

/**
 * Service for reading and writing shared team knowledge from configured
 * directories. Entries are stored as JSONL files, one per category.
 *
 * Design:
 * - Reads from all configured source directories.
 * - Writes to the first writable source directory.
 * - Auto-prunes entries older than 180 days.
 * - Gracefully handles missing or unreadable directories.
 */
export class TeamKnowledgeService {
  private sources: string[] = [];
  private entriesCache: TeamKnowledgeEntry[] | null = null;
  private cacheAge: number = 0;
  private readonly CACHE_TTL_MS = 120_000; // 2 minutes

  /**
   * Configure the source directories for team knowledge.
   *
   * @param sources Array of directory paths to read team knowledge from.
   *   The first writable directory is used for writes.
   */
  setSources(sources: string[]): void {
    this.sources = sources.filter(Boolean);
    this.entriesCache = null; // Invalidate cache on reconfiguration
  }

  /**
   * Get configured sources.
   */
  getSources(): string[] {
    return [...this.sources];
  }

  // -------------------------------------------------------------------------
  // Public API: Loading
  // -------------------------------------------------------------------------

  /**
   * Load all team knowledge entries from all configured source directories.
   * Results are deduplicated by ID, with newer entries winning.
   */
  async loadFromSources(): Promise<TeamKnowledgeEntry[]> {
    const now = Date.now();
    if (this.entriesCache && now - this.cacheAge < this.CACHE_TTL_MS) {
      return this.entriesCache;
    }

    const allEntries = new Map<string, TeamKnowledgeEntry>();
    const cutoff = Date.now() - PRUNE_AGE_DAYS * 24 * 60 * 60 * 1000;

    for (const source of this.sources) {
      if (!(await dirExists(source))) {
        debugLogger.debug(`TeamKnowledge: source not found: ${source}`);
        continue;
      }

      for (const categoryFile of Object.values(CATEGORY_FILES)) {
        const filePath = path.join(source, categoryFile);
        const entries = await readJsonlFile<TeamKnowledgeEntry>(filePath);

        for (const entry of entries) {
          // Skip expired entries
          if (entry.timestamp < cutoff) continue;

          // Deduplicate: newer wins
          const existing = allEntries.get(entry.id);
          if (!existing || entry.timestamp > existing.timestamp) {
            allEntries.set(entry.id, entry);
          }
        }
      }
    }

    const result = Array.from(allEntries.values()).sort(
      (a, b) => b.timestamp - a.timestamp,
    );

    this.entriesCache = result;
    this.cacheAge = now;
    return result;
  }

  // -------------------------------------------------------------------------
  // Public API: Search
  // -------------------------------------------------------------------------

  /**
   * Search team knowledge entries by keyword matching against title,
   * content, and tags.
   *
   * @param query Search string (case-insensitive).
   * @param limit Maximum results to return (default 10).
   */
  search(query: string, limit: number = 10): TeamKnowledgeEntry[] {
    if (!this.entriesCache || this.entriesCache.length === 0) {
      return [];
    }

    if (!query.trim()) {
      return this.entriesCache.slice(0, limit);
    }

    const queryTokens = new Set(
      query
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length > 1),
    );
    if (queryTokens.size === 0) {
      return this.entriesCache.slice(0, limit);
    }

    return this.entriesCache
      .map((entry) => {
        const text =
          `${entry.title} ${entry.content} ${entry.tags.join(' ')} ${entry.category}`.toLowerCase();
        const textTokens = new Set(
          text.split(/\W+/).filter((t) => t.length > 1),
        );

        let matches = 0;
        for (const token of queryTokens) {
          if (textTokens.has(token)) matches++;
        }

        return { entry, score: matches / queryTokens.size };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.upvotes - a.entry.upvotes)
      .slice(0, limit)
      .map((r) => r.entry);
  }

  // -------------------------------------------------------------------------
  // Public API: Writing
  // -------------------------------------------------------------------------

  /**
   * Save a new team knowledge entry to the first writable source directory.
   *
   * @param entry The entry to save (id and timestamp are auto-generated).
   * @throws If no writable source directory is available.
   */
  async saveEntry(
    entry: Omit<TeamKnowledgeEntry, 'id' | 'timestamp'>,
  ): Promise<TeamKnowledgeEntry> {
    const writeDir = await this.findWritableSource();
    if (!writeDir) {
      throw new Error(
        'TeamKnowledge: no writable source directory configured.',
      );
    }

    const fullEntry: TeamKnowledgeEntry = {
      ...entry,
      id: generateId(),
      timestamp: Date.now(),
      content: entry.content.slice(0, MAX_CONTENT_LENGTH),
    };

    const categoryFile = CATEGORY_FILES[entry.category];
    const filePath = path.join(writeDir, categoryFile);
    await appendJsonlFile(filePath, fullEntry);

    // Invalidate cache
    this.entriesCache = null;

    debugLogger.debug(
      `TeamKnowledge: saved entry "${fullEntry.title}" to ${filePath}`,
    );

    return fullEntry;
  }

  // -------------------------------------------------------------------------
  // Public API: Context formatting
  // -------------------------------------------------------------------------

  /**
   * Format relevant team knowledge for prompt injection.
   * Returns a <team_knowledge> block capped at MAX_CONTEXT_BYTES (~1KB).
   *
   * @param query Optional query to filter relevant entries.
   */
  formatTeamContext(query: string): string {
    const entries = query ? this.search(query, 5) : this.getTopEntries(5);

    if (entries.length === 0) return '';

    const lines = entries.map((e) => {
      const tags = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : '';
      return `- [${e.category}] ${e.title}: ${e.content}${tags}`;
    });

    const context = `<team_knowledge>\n${lines.join('\n')}\n</team_knowledge>`;
    return truncateToBytes(context, MAX_CONTEXT_BYTES);
  }

  // -------------------------------------------------------------------------
  // Public API: Stats
  // -------------------------------------------------------------------------

  /**
   * Compute aggregate statistics from team knowledge entries.
   */
  getStats(): TeamKnowledgeStats {
    const entries = this.entriesCache ?? [];
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

    const entriesThisWeek = entries.filter((e) => e.timestamp > weekAgo).length;

    // Count by author
    const authorCounts = new Map<string, number>();
    const categoryCounts: Record<string, number> = {};

    for (const entry of entries) {
      authorCounts.set(entry.author, (authorCounts.get(entry.author) ?? 0) + 1);
      categoryCounts[entry.category] =
        (categoryCounts[entry.category] ?? 0) + 1;
    }

    const topContributors = Array.from(authorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([author, count]) => ({ author, count }));

    return {
      totalEntries: entries.length,
      entriesThisWeek,
      topContributors,
      categoryCounts,
    };
  }

  // -------------------------------------------------------------------------
  // Public API: Pruning
  // -------------------------------------------------------------------------

  /**
   * Prune entries older than PRUNE_AGE_DAYS from all writable sources.
   * Also caps per-file entry count to MAX_ENTRIES_PER_FILE.
   */
  async pruneOldEntries(): Promise<number> {
    let pruned = 0;
    const cutoff = Date.now() - PRUNE_AGE_DAYS * 24 * 60 * 60 * 1000;

    for (const source of this.sources) {
      if (!(await isWritable(source))) continue;

      for (const categoryFile of Object.values(CATEGORY_FILES)) {
        const filePath = path.join(source, categoryFile);
        const entries = await readJsonlFile<TeamKnowledgeEntry>(filePath);
        if (entries.length === 0) continue;

        let filtered = entries.filter((e) => e.timestamp >= cutoff);
        const removedCount = entries.length - filtered.length;

        if (filtered.length > MAX_ENTRIES_PER_FILE) {
          filtered = filtered.slice(filtered.length - MAX_ENTRIES_PER_FILE);
        }

        if (removedCount > 0 || entries.length !== filtered.length) {
          try {
            await ensureDir(path.dirname(filePath));
            const content =
              filtered.map((e) => JSON.stringify(e)).join('\n') + '\n';
            await fs.writeFile(filePath, content, 'utf-8');
            pruned += entries.length - filtered.length;
          } catch (error) {
            debugLogger.debug(
              `TeamKnowledge: pruning failed for ${filePath}:`,
              error,
            );
          }
        }
      }
    }

    if (pruned > 0) {
      this.entriesCache = null; // Invalidate cache
      debugLogger.debug(`TeamKnowledge: pruned ${pruned} old entries`);
    }

    return pruned;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Get the top entries by upvotes (most popular).
   */
  private getTopEntries(limit: number): TeamKnowledgeEntry[] {
    if (!this.entriesCache) return [];
    return [...this.entriesCache]
      .sort((a, b) => b.upvotes - a.upvotes)
      .slice(0, limit);
  }

  /**
   * Find the first writable source directory.
   * Creates the directory if it doesn't exist but the parent is writable.
   */
  private async findWritableSource(): Promise<string | null> {
    for (const source of this.sources) {
      if (await dirExists(source)) {
        if (await isWritable(source)) {
          return source;
        }
      } else {
        // Try to create the directory
        try {
          await fs.mkdir(source, { recursive: true });
          return source;
        } catch {
          // Parent not writable
        }
      }
    }
    return null;
  }
}
