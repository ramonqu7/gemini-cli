/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs';
import { homedir, GEMINI_DIR } from '../utils/paths.js';
import { debugLogger } from '../utils/debugLogger.js';

/**
 * Maximum number of history entries to keep on disk.
 * When exceeded, the oldest entries are pruned.
 */
const MAX_HISTORY_ENTRIES = 10_000;

/**
 * A single entry in the command history.
 */
export interface CommandHistoryEntry {
  timestamp: string;
  prompt: string;
  model: string;
}

/**
 * Returns the path to the history file: ~/.gemini/history.jsonl
 */
function getHistoryFilePath(): string {
  return path.join(homedir(), GEMINI_DIR, 'history.jsonl');
}

/**
 * Ensures the parent directory for the history file exists.
 */
function ensureHistoryDir(): void {
  const dir = path.join(homedir(), GEMINI_DIR);
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Persistent command history service.
 *
 * Stores user prompts in an append-only JSONL file at ~/.gemini/history.jsonl.
 * Supports retrieval and substring search over past prompts.
 */
export class CommandHistoryService {
  private filePath: string;

  constructor() {
    this.filePath = getHistoryFilePath();
  }

  /**
   * Appends a prompt to the history file.
   *
   * @param prompt - The user prompt text.
   * @param model - The model name active at the time.
   */
  addEntry(prompt: string, model: string): void {
    if (!prompt.trim()) {
      return;
    }

    try {
      ensureHistoryDir();

      const entry: CommandHistoryEntry = {
        timestamp: new Date().toISOString(),
        prompt: prompt.trim(),
        model,
      };

      fs.appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');

      // Check if rotation is needed (async to avoid blocking)
      this.maybeRotate();
    } catch (error) {
      debugLogger.debug(`Failed to save command history: ${error}`);
    }
  }

  /**
   * Returns the most recent history entries.
   *
   * @param limit - Maximum number of entries to return. Defaults to 20.
   * @returns An array of history entries, newest first.
   */
  getHistory(limit: number = 20): CommandHistoryEntry[] {
    const all = this.readAllEntries();
    return all.slice(-limit).reverse();
  }

  /**
   * Searches history entries by substring match on the prompt text.
   *
   * @param query - The substring to search for (case-insensitive).
   * @param limit - Maximum number of results to return. Defaults to 20.
   * @returns Matching entries, newest first.
   */
  searchHistory(query: string, limit: number = 20): CommandHistoryEntry[] {
    if (!query.trim()) {
      return this.getHistory(limit);
    }

    const lowerQuery = query.toLowerCase();
    const all = this.readAllEntries();
    const matches = all.filter((entry) =>
      entry.prompt.toLowerCase().includes(lowerQuery),
    );
    return matches.slice(-limit).reverse();
  }

  /**
   * Reads all entries from the history file.
   */
  private readAllEntries(): CommandHistoryEntry[] {
    try {
      if (!fs.existsSync(this.filePath)) {
        return [];
      }

      const content = fs.readFileSync(this.filePath, 'utf-8');
      const lines = content.split('\n').filter((line) => line.trim());
      const entries: CommandHistoryEntry[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as CommandHistoryEntry;
          if (entry.timestamp && entry.prompt) {
            entries.push(entry);
          }
        } catch {
          // Skip malformed lines
        }
      }

      return entries;
    } catch (error) {
      debugLogger.debug(`Failed to read command history: ${error}`);
      return [];
    }
  }

  /**
   * Rotates the history file if it exceeds MAX_HISTORY_ENTRIES.
   * Keeps the most recent entries and rewrites the file.
   */
  private maybeRotate(): void {
    try {
      const entries = this.readAllEntries();
      if (entries.length <= MAX_HISTORY_ENTRIES) {
        return;
      }

      // Keep the most recent entries
      const toKeep = entries.slice(-MAX_HISTORY_ENTRIES);
      const content = toKeep.map((e) => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(this.filePath, content, 'utf-8');
    } catch (error) {
      debugLogger.debug(`Failed to rotate command history: ${error}`);
    }
  }
}
