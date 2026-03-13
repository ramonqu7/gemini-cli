/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Storage } from '../config/storage.js';
import { debugLogger } from '../utils/debugLogger.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum elapsed time (ms) before re-fetching on session start. */
const MIN_FETCH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Interval between background fetches during a session. */
const SESSION_FETCH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum items to keep per source per fetch. */
const MAX_ITEMS_PER_FETCH = 10;

/** Maximum total items stored across all sources. */
const MAX_TOTAL_ITEMS = 500;

/** Maximum retention period (ms) before an item is pruned. */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** Maximum context size in bytes for prompt injection. */
const MAX_CONTEXT_BYTES = 1024;

/** Timeout for shell commands (ms). */
const SHELL_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Describes a source of ingestion data (CLs, bugs, code ownership, etc.).
 */
export interface IngestionSource {
  /** Human-readable name for this source. */
  name: string;
  /** The kind of data this source produces. */
  type: 'cl' | 'bug' | 'doc' | 'code';
  /** Milliseconds between fetches for this source. */
  fetchInterval: number;
  /** Epoch ms of the last successful fetch (0 = never). */
  lastFetched: number;
}

/**
 * A single piece of knowledge extracted from an ingestion source.
 */
export interface IngestedItem {
  /** Which source produced this item. */
  source: string;
  /** The type of this item (mirrors IngestionSource.type). */
  type: string;
  /** Short title / description (max 200 chars). */
  title: string;
  /** Concise summary of the item (max 200 chars). */
  summary: string;
  /** Epoch ms when this item was ingested. */
  timestamp: number;
  /** Arbitrary metadata (CL number, bug ID, file path, etc.). */
  metadata: Record<string, string>;
}

/**
 * Persisted state that tracks when each source was last fetched.
 */
interface IngestionState {
  sources: Record<string, { lastFetched: number }>;
}

// ---------------------------------------------------------------------------
// Ingestion strategies
// ---------------------------------------------------------------------------

/**
 * Fetches recent CLs by running VCS log commands (hg / git / p4).
 */
class CLIngestionStrategy {
  async fetch(userLdap: string): Promise<IngestedItem[]> {
    const items: IngestedItem[] = [];

    // Try hg first (Piper/Fig), then git, then p4
    const strategies: Array<() => Promise<IngestedItem[]>> = [
      () => this.fetchHg(userLdap),
      () => this.fetchGit(userLdap),
    ];

    for (const strategy of strategies) {
      try {
        const result = await strategy();
        if (result.length > 0) {
          items.push(...result);
          break;
        }
      } catch {
        // Strategy not available, try next
      }
    }

    return items.slice(0, MAX_ITEMS_PER_FETCH);
  }

  private async fetchHg(userLdap: string): Promise<IngestedItem[]> {
    const { stdout } = await execFileAsync(
      'hg',
      [
        'log',
        '--user',
        userLdap,
        '--limit',
        String(MAX_ITEMS_PER_FETCH),
        '--template',
        '{node|short}\\t{desc|firstline}\\t{date|isodate}\\n',
      ],
      { timeout: SHELL_TIMEOUT_MS },
    );

    return this.parseLogOutput(stdout, 'hg');
  }

  private async fetchGit(userLdap: string): Promise<IngestedItem[]> {
    const { stdout } = await execFileAsync(
      'git',
      [
        'log',
        `--author=${userLdap}`,
        `--max-count=${MAX_ITEMS_PER_FETCH}`,
        '--format=%h\t%s\t%ci',
      ],
      { timeout: SHELL_TIMEOUT_MS },
    );

    return this.parseLogOutput(stdout, 'git');
  }

  private parseLogOutput(stdout: string, vcs: string): IngestedItem[] {
    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.map((line) => {
      const parts = line.split('\t');
      const hash = parts[0] ?? '';
      const desc = (parts[1] ?? '').slice(0, 200);
      const date = parts[2] ?? '';
      return {
        source: `${vcs}-log`,
        type: 'cl',
        title: desc,
        summary: `${vcs} ${hash}: ${desc}`,
        timestamp: date ? new Date(date).getTime() : Date.now(),
        metadata: { hash, vcs },
      };
    });
  }
}

/**
 * Analyzes recently modified files to determine code ownership patterns.
 */
class CodeOwnershipStrategy {
  async analyze(recentCLs: IngestedItem[]): Promise<IngestedItem[]> {
    // Extract directories from CL descriptions as a heuristic
    const dirCounts = new Map<string, number>();

    for (const cl of recentCLs) {
      // Try to extract path-like strings from CL titles
      const pathMatches = cl.title.match(
        /(?:src|lib|pkg|packages|internal|cmd)\/[\w/.-]+/g,
      );
      if (pathMatches) {
        for (const match of pathMatches) {
          const dir = path.dirname(match);
          dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
        }
      }
    }

    // Also try to get recently modified files from git/hg
    try {
      const items = await this.fetchRecentlyModifiedDirs();
      for (const item of items) {
        const dir = item.metadata['dir'] ?? '';
        if (dir) {
          dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
        }
      }
    } catch {
      // VCS not available
    }

    // Convert to ownership items, sorted by frequency
    const sorted = [...dirCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (sorted.length === 0) return [];

    const dirs = sorted.map(([dir, count]) => `${dir} (${count}x)`).join(', ');
    return [
      {
        source: 'ownership-analysis',
        type: 'code',
        title: 'Frequently modified directories',
        summary: `You frequently modify: ${dirs}`.slice(0, 200),
        timestamp: Date.now(),
        metadata: {
          directories: sorted.map(([d]) => d).join(','),
        },
      },
    ];
  }

  private async fetchRecentlyModifiedDirs(): Promise<IngestedItem[]> {
    // Try git first
    try {
      const { stdout } = await execFileAsync(
        'git',
        [
          'log',
          '--max-count=20',
          '--name-only',
          '--format=',
          '--diff-filter=AM',
        ],
        { timeout: SHELL_TIMEOUT_MS },
      );

      const dirCounts = new Map<string, number>();
      for (const file of stdout.trim().split('\n').filter(Boolean)) {
        const dir = path.dirname(file);
        dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
      }

      return [...dirCounts.entries()].map(([dir, count]) => ({
        source: 'git-files',
        type: 'code' as const,
        title: dir,
        summary: `Modified ${count} files in ${dir}`,
        timestamp: Date.now(),
        metadata: { dir, count: String(count) },
      }));
    } catch {
      return [];
    }
  }
}

/**
 * Reads local project structure files (package.json, OWNERS, BUILD, GEMINI.md).
 */
class ProjectStructureStrategy {
  async analyze(cwd: string): Promise<IngestedItem[]> {
    const items: IngestedItem[] = [];
    const filesToCheck = [
      'package.json',
      'OWNERS',
      'BUILD',
      'GEMINI.md',
      '.gemini/GEMINI.md',
    ];

    for (const file of filesToCheck) {
      try {
        const filePath = path.join(cwd, file);
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) continue;

        const content = await fs.readFile(filePath, 'utf-8');
        const summary = this.extractSummary(file, content);
        if (summary) {
          items.push({
            source: 'project-structure',
            type: 'doc',
            title: file,
            summary: summary.slice(0, 200),
            timestamp: stat.mtimeMs,
            metadata: { path: filePath },
          });
        }
      } catch {
        // File doesn't exist or can't be read
      }
    }

    return items.slice(0, MAX_ITEMS_PER_FETCH);
  }

  private extractSummary(filename: string, content: string): string | null {
    if (filename === 'package.json') {
      try {
        const pkg = JSON.parse(content) as Record<string, unknown>;
        const name = (pkg['name'] as string) ?? 'unknown';
        const desc = (pkg['description'] as string) ?? '';
        return `Project: ${name}${desc ? ` - ${desc}` : ''}`;
      } catch {
        return null;
      }
    }

    if (filename === 'OWNERS') {
      const owners = content
        .split('\n')
        .filter((l) => l.trim() && !l.startsWith('#'))
        .slice(0, 5);
      return `Owners: ${owners.join(', ')}`;
    }

    if (filename.endsWith('.md')) {
      const firstLine = content.split('\n').find((l) => l.trim());
      return firstLine?.slice(0, 200) ?? null;
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/**
 * Returns the root directory for ingestion data: ~/.gemini/knowledge/ingestion/
 */
function getIngestionDir(): string {
  return path.join(Storage.getGlobalGeminiDir(), 'knowledge', 'ingestion');
}

function getStatePath(): string {
  return path.join(getIngestionDir(), 'state.json');
}

function getItemsPath(): string {
  return path.join(getIngestionDir(), 'items.jsonl');
}

function getOwnershipPath(): string {
  return path.join(getIngestionDir(), 'ownership.json');
}

async function ensureIngestionDir(): Promise<void> {
  await fs.mkdir(getIngestionDir(), { recursive: true });
}

async function loadState(): Promise<IngestionState> {
  try {
    const content = await fs.readFile(getStatePath(), 'utf-8');
    return JSON.parse(content) as IngestionState;
  } catch {
    return { sources: {} };
  }
}

async function saveState(state: IngestionState): Promise<void> {
  await ensureIngestionDir();
  await fs.writeFile(getStatePath(), JSON.stringify(state, null, 2), 'utf-8');
}

async function loadItems(): Promise<IngestedItem[]> {
  try {
    const content = await fs.readFile(getItemsPath(), 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line) as IngestedItem);
  } catch {
    return [];
  }
}

async function appendItems(newItems: IngestedItem[]): Promise<void> {
  if (newItems.length === 0) return;
  await ensureIngestionDir();

  const lines = newItems.map((item) => JSON.stringify(item)).join('\n') + '\n';
  await fs.appendFile(getItemsPath(), lines, 'utf-8');
}

async function pruneItems(): Promise<void> {
  const items = await loadItems();
  const now = Date.now();

  // Remove expired items
  let pruned = items.filter((item) => now - item.timestamp < RETENTION_MS);

  // Cap total items
  if (pruned.length > MAX_TOTAL_ITEMS) {
    pruned = pruned.slice(pruned.length - MAX_TOTAL_ITEMS);
  }

  // Rewrite the file
  await ensureIngestionDir();
  const lines = pruned.map((item) => JSON.stringify(item)).join('\n');
  await fs.writeFile(getItemsPath(), lines ? lines + '\n' : '', 'utf-8');
}

async function saveOwnership(items: IngestedItem[]): Promise<void> {
  await ensureIngestionDir();
  await fs.writeFile(
    getOwnershipPath(),
    JSON.stringify(items, null, 2),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// Relevance scoring
// ---------------------------------------------------------------------------

/**
 * Computes a simple keyword-overlap relevance score between a query and an
 * ingested item. Returns 0..1.
 */
function relevanceScore(query: string, item: IngestedItem): number {
  const queryTokens = new Set(
    query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 2),
  );
  if (queryTokens.size === 0) return 0;

  const itemText = `${item.title} ${item.summary} ${Object.values(item.metadata).join(' ')}`.toLowerCase();
  const itemTokens = new Set(
    itemText.split(/\W+/).filter((t) => t.length > 2),
  );

  let matches = 0;
  for (const token of queryTokens) {
    if (itemTokens.has(token)) matches++;
  }

  return matches / queryTokens.size;
}

// ---------------------------------------------------------------------------
// BackgroundIngestionService
// ---------------------------------------------------------------------------

/**
 * Background service that slowly learns about the user by periodically
 * ingesting their recent CLs, project structure, and code ownership patterns.
 *
 * Design principles:
 * - Never blocks the main conversation loop.
 * - Each ingestion cycle completes in <5 seconds (shell command timeout).
 * - Storage is capped (500 items, 90-day retention).
 * - State persists across sessions.
 * - Gracefully degrades when VCS or tools are unavailable.
 */
export class BackgroundIngestionService {
  private sources: IngestionSource[] = [];
  private items: IngestedItem[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cwd: string = process.cwd();

  private clStrategy = new CLIngestionStrategy();
  private ownershipStrategy = new CodeOwnershipStrategy();
  private projectStrategy = new ProjectStructureStrategy();

  constructor() {
    // Register default sources
    this.registerSource({
      name: 'recent-cls',
      type: 'cl',
      fetchInterval: MIN_FETCH_INTERVAL_MS,
      lastFetched: 0,
    });
    this.registerSource({
      name: 'code-ownership',
      type: 'code',
      fetchInterval: MIN_FETCH_INTERVAL_MS,
      lastFetched: 0,
    });
    this.registerSource({
      name: 'project-structure',
      type: 'doc',
      fetchInterval: MIN_FETCH_INTERVAL_MS,
      lastFetched: 0,
    });
  }

  /**
   * Register an ingestion source. Duplicate names are replaced.
   */
  registerSource(source: IngestionSource): void {
    const idx = this.sources.findIndex((s) => s.name === source.name);
    if (idx >= 0) {
      this.sources[idx] = source;
    } else {
      this.sources.push(source);
    }
  }

  /**
   * Start the background ingestion loop. Call on session start.
   *
   * @param userLdap The user's LDAP username (used to filter VCS logs).
   * @param cwd Optional working directory override.
   */
  async start(userLdap: string, cwd?: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cwd = cwd ?? process.cwd();

    debugLogger.debug('Background ingestion: starting for user', userLdap);

    // Load persisted state
    const state = await loadState();
    for (const source of this.sources) {
      const saved = state.sources[source.name];
      if (saved) {
        source.lastFetched = saved.lastFetched;
      }
    }

    // Load persisted items into memory
    this.items = await loadItems();

    // Initial fetch if stale
    await this.runIngestionCycle(userLdap);

    // Schedule periodic fetches
    this.intervalId = setInterval(() => {
      this.runIngestionCycle(userLdap).catch((error) => {
        debugLogger.debug('Background ingestion: cycle failed:', error);
      });
    }, SESSION_FETCH_INTERVAL_MS);

    // Don't let the interval prevent Node from exiting
    if (this.intervalId && typeof this.intervalId === 'object' && 'unref' in this.intervalId) {
      this.intervalId.unref();
    }
  }

  /**
   * Stop the background ingestion loop. Call on session end.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
    debugLogger.debug('Background ingestion: stopped');
  }

  /**
   * Returns ingested items that are relevant to the given query, sorted by
   * descending relevance.
   */
  getRelevantItems(query: string, limit: number = 10): IngestedItem[] {
    if (!query || this.items.length === 0) {
      // Return most recent items if no query
      return this.items
        .slice()
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, limit);
    }

    return this.items
      .map((item) => ({ item, score: relevanceScore(query, item) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => r.item);
  }

  /**
   * Format ingested context for injection into a system/user prompt.
   * The output is capped at MAX_CONTEXT_BYTES (~1KB) to minimize prompt
   * overhead.
   */
  formatIngestionContext(query: string): string {
    if (this.items.length === 0) return '';

    const clItems = this.items
      .filter((i) => i.type === 'cl')
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 5);

    const codeItems = this.items
      .filter((i) => i.type === 'code')
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 3);

    const docItems = this.items
      .filter((i) => i.type === 'doc')
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 3);

    // If a query is provided, also include relevant items
    const relevant = query ? this.getRelevantItems(query, 5) : [];
    const relevantNotAlready = relevant.filter(
      (r) =>
        !clItems.some((c) => c.summary === r.summary) &&
        !codeItems.some((c) => c.summary === r.summary) &&
        !docItems.some((c) => c.summary === r.summary),
    );

    const sections: string[] = [];

    if (clItems.length > 0) {
      const cls = clItems.map((i) => `"${i.title}" (${i.metadata['hash'] ?? ''})`).join(', ');
      sections.push(`Recent CLs: ${cls}`);
    }

    if (codeItems.length > 0) {
      const codes = codeItems.map((i) => i.summary).join('; ');
      sections.push(`Code ownership: ${codes}`);
    }

    if (docItems.length > 0) {
      const docs = docItems.map((i) => `${i.title}: ${i.summary}`).join('; ');
      sections.push(`Project context: ${docs}`);
    }

    if (relevantNotAlready.length > 0) {
      const rel = relevantNotAlready.map((i) => i.summary).join('; ');
      sections.push(`Related to query: ${rel}`);
    }

    if (sections.length === 0) return '';

    let context = `<recent_work>\n${sections.join('\n')}\n</recent_work>`;

    // Enforce size cap
    if (Buffer.byteLength(context, 'utf-8') > MAX_CONTEXT_BYTES) {
      // Truncate progressively: remove "Related to query" first, then others
      while (
        sections.length > 1 &&
        Buffer.byteLength(
          `<recent_work>\n${sections.join('\n')}\n</recent_work>`,
          'utf-8',
        ) > MAX_CONTEXT_BYTES
      ) {
        sections.pop();
      }
      context = `<recent_work>\n${sections.join('\n')}\n</recent_work>`;

      // If still too large, hard-truncate (UTF-8 safe)
      if (Buffer.byteLength(context, 'utf-8') > MAX_CONTEXT_BYTES) {
        const encoder = new TextEncoder();
        const encoded = encoder.encode(context);
        let end = MAX_CONTEXT_BYTES - 20;
        // Walk back to a valid UTF-8 character boundary: skip continuation
        // bytes (0x80..0xBF) so we don't split a multi-byte sequence.
        while (end > 0 && (encoded[end]! & 0xc0) === 0x80) {
          end--;
        }
        const truncated = encoded.slice(0, end);
        context =
          new TextDecoder().decode(truncated) + '...\n</recent_work>';
      }
    }

    return context;
  }

  /**
   * Get all ingested items (for debugging / inspection).
   */
  getAllItems(): IngestedItem[] {
    return [...this.items];
  }

  /**
   * Get item count by type (for debugging / inspection).
   */
  getItemCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of this.items) {
      counts[item.type] = (counts[item.type] ?? 0) + 1;
    }
    return counts;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private async runIngestionCycle(userLdap: string): Promise<void> {
    const now = Date.now();
    const newItems: IngestedItem[] = [];

    for (const source of this.sources) {
      if (now - source.lastFetched < source.fetchInterval) {
        continue; // Not yet time to fetch this source
      }

      try {
        const items = await this.fetchSource(source, userLdap);
        if (items.length > 0) {
          newItems.push(...items);
          source.lastFetched = now;
          debugLogger.debug(
            `Background ingestion: fetched ${items.length} items from ${source.name}`,
          );
        }
      } catch (error) {
        debugLogger.debug(
          `Background ingestion: failed to fetch ${source.name}:`,
          error,
        );
      }
    }

    if (newItems.length > 0) {
      // Deduplicate against existing items
      const deduped = newItems.filter(
        (newItem) =>
          !this.items.some(
            (existing) =>
              existing.source === newItem.source &&
              existing.title === newItem.title,
          ),
      );

      if (deduped.length > 0) {
        this.items.push(...deduped);
        await appendItems(deduped);
      }

      // Prune old / excess items
      await pruneItems();
      this.items = await loadItems();
    }

    // Persist state
    const state = await loadState();
    for (const source of this.sources) {
      state.sources[source.name] = { lastFetched: source.lastFetched };
    }
    await saveState(state);
  }

  private async fetchSource(
    source: IngestionSource,
    userLdap: string,
  ): Promise<IngestedItem[]> {
    switch (source.name) {
      case 'recent-cls':
        return this.clStrategy.fetch(userLdap);

      case 'code-ownership': {
        const clItems = this.items.filter((i) => i.type === 'cl');
        const ownership = await this.ownershipStrategy.analyze(clItems);
        if (ownership.length > 0) {
          await saveOwnership(ownership);
        }
        return ownership;
      }

      case 'project-structure':
        return this.projectStrategy.analyze(this.cwd);

      default:
        debugLogger.debug(
          `Background ingestion: unknown source "${source.name}"`,
        );
        return [];
    }
  }
}
