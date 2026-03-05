/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs';
import { createGzip, createGunzip } from 'node:zlib';
import { gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { Content } from '@google/genai';
import { homedir, GEMINI_DIR } from '../utils/paths.js';
import { debugLogger } from '../utils/debugLogger.js';

/**
 * Maximum number of persisted sessions to keep on disk.
 */
const MAX_SESSIONS = 50;

/**
 * Sessions older than this many days are automatically cleaned up.
 */
const SESSION_MAX_AGE_DAYS = 7;

/**
 * Minimum interval in milliseconds between auto-saves.
 */
const AUTO_SAVE_DEBOUNCE_MS = 30_000;

/**
 * Sessions larger than this threshold (in bytes) are gzipped on disk.
 */
const GZIP_THRESHOLD_BYTES = 1_000_000;

/**
 * Represents a session persisted to disk for later resumption.
 */
export interface PersistedSession {
  sessionId: string;
  timestamp: number;
  model: string;
  workingDirectory: string;
  conversationPreview: string;
  history: Content[];
  systemInstruction?: string;
  tokenCount: number;
  turnCount: number;
}

/**
 * Returns the directory used for persisted sessions: ~/.gemini/sessions/
 */
function getSessionsDir(): string {
  return path.join(homedir(), GEMINI_DIR, 'sessions');
}

/**
 * Ensures the sessions directory exists.
 */
function ensureSessionsDir(): void {
  const dir = getSessionsDir();
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Returns the base file path for a given session ID (without .gz extension).
 */
function sessionFilePath(sessionId: string): string {
  return path.join(getSessionsDir(), `${sessionId}.json`);
}

/**
 * Service for persisting and resuming conversations across terminal restarts.
 *
 * Sessions are stored as JSON files in ~/.gemini/sessions/. Files larger
 * than 1 MB are automatically gzipped. Old sessions (>7 days) and excess
 * sessions (>50) are pruned on startup.
 */
export class SessionPersistenceService {
  private lastAutoSaveTimestamp = 0;

  /**
   * Saves a session to disk.
   *
   * @param sessionId - Unique session identifier.
   * @param history - The Gemini Content[] conversation history.
   * @param model - The model identifier used in the session.
   * @param systemInstruction - Optional system instruction text.
   */
  async saveSession(
    sessionId: string,
    history: Content[],
    model: string,
    systemInstruction?: string,
  ): Promise<void> {
    try {
      ensureSessionsDir();

      const turnCount = history.filter((c) => c.role === 'user').length;
      const lastUserMessage = [...history]
        .reverse()
        .find((c) => c.role === 'user');
      const preview = lastUserMessage?.parts
        ?.map((p) => p.text ?? '')
        .join('')
        .slice(0, 200) ?? '';

      const tokenCount = JSON.stringify(history).length;

      const session: PersistedSession = {
        sessionId,
        timestamp: Date.now(),
        model,
        workingDirectory: process.cwd(),
        conversationPreview: preview,
        history,
        systemInstruction,
        tokenCount,
        turnCount,
      };

      const jsonData = JSON.stringify(session, null, 2);
      const filePath = sessionFilePath(sessionId);

      if (Buffer.byteLength(jsonData, 'utf8') > GZIP_THRESHOLD_BYTES) {
        await pipeline(
          Readable.from([jsonData]),
          createGzip(),
          fs.createWriteStream(`${filePath}.gz`),
        );
        // Remove uncompressed version if it exists
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Ignore if not present
        }
      } else {
        fs.writeFileSync(filePath, jsonData, 'utf8');
        // Remove compressed version if it exists
        try {
          fs.unlinkSync(`${filePath}.gz`);
        } catch {
          // Ignore if not present
        }
      }
    } catch (error) {
      debugLogger.error('Error saving session:', error);
    }
  }

  /**
   * Debounced auto-save. Saves only if at least AUTO_SAVE_DEBOUNCE_MS
   * milliseconds have elapsed since the last auto-save.
   */
  async autoSave(
    sessionId: string,
    history: Content[],
    model: string,
    systemInstruction?: string,
  ): Promise<void> {
    const now = Date.now();
    if (now - this.lastAutoSaveTimestamp < AUTO_SAVE_DEBOUNCE_MS) {
      return;
    }
    this.lastAutoSaveTimestamp = now;
    await this.saveSession(sessionId, history, model, systemInstruction);
  }

  /**
   * Forces the next autoSave call to proceed regardless of debounce timing.
   * Useful for ensuring a save happens after each user turn completes.
   */
  resetAutoSaveTimer(): void {
    this.lastAutoSaveTimestamp = 0;
  }

  /**
   * Lists all saved sessions, sorted by timestamp (most recent first).
   */
  listSessions(): PersistedSession[] {
    try {
      const dir = getSessionsDir();
      if (!fs.existsSync(dir)) {
        return [];
      }

      const files = fs.readdirSync(dir).filter(
        (f) => f.endsWith('.json') || f.endsWith('.json.gz'),
      );

      const sessions: PersistedSession[] = [];
      for (const file of files) {
        try {
          const session = this.readSessionFile(path.join(dir, file));
          if (session) {
            // Return without history for listing (save memory)
            sessions.push({
              ...session,
              history: [],
            });
          }
        } catch {
          debugLogger.debug(`Skipping unreadable session file: ${file}`);
        }
      }

      sessions.sort((a, b) => b.timestamp - a.timestamp);
      return sessions;
    } catch (error) {
      debugLogger.error('Error listing sessions:', error);
      return [];
    }
  }

  /**
   * Loads a session by ID. Returns the full session including history.
   */
  loadSession(sessionId: string): PersistedSession | null {
    try {
      const jsonPath = sessionFilePath(sessionId);
      const gzPath = `${jsonPath}.gz`;

      if (fs.existsSync(gzPath)) {
        return this.readSessionFile(gzPath);
      }
      if (fs.existsSync(jsonPath)) {
        return this.readSessionFile(jsonPath);
      }
      return null;
    } catch (error) {
      debugLogger.error(`Error loading session ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Returns the most recently saved session.
   */
  getLastSession(): PersistedSession | null {
    const sessions = this.listSessions();
    if (sessions.length === 0) {
      return null;
    }
    // listSessions returns stubs without history; load the full session
    return this.loadSession(sessions[0].sessionId);
  }

  /**
   * Deletes a session by ID.
   */
  deleteSession(sessionId: string): void {
    try {
      const jsonPath = sessionFilePath(sessionId);
      const gzPath = `${jsonPath}.gz`;

      if (fs.existsSync(jsonPath)) {
        fs.unlinkSync(jsonPath);
      }
      if (fs.existsSync(gzPath)) {
        fs.unlinkSync(gzPath);
      }
    } catch (error) {
      debugLogger.error(`Error deleting session ${sessionId}:`, error);
    }
  }

  /**
   * Returns a human-readable formatted list of saved sessions.
   */
  formatSessionList(): string {
    const sessions = this.listSessions();
    if (sessions.length === 0) {
      return 'No saved sessions found.';
    }

    const lines: string[] = ['Saved sessions:', ''];
    for (const session of sessions) {
      const date = new Date(session.timestamp);
      const dateStr = date.toLocaleString();
      const preview = session.conversationPreview
        ? ` - "${session.conversationPreview.slice(0, 80)}${session.conversationPreview.length > 80 ? '...' : ''}"`
        : '';
      lines.push(
        `  ${session.sessionId.slice(0, 8)}  ${dateStr}  [${session.model}]  ${session.turnCount} turns${preview}`,
      );
    }
    lines.push('');
    lines.push(`Total: ${sessions.length} session(s)`);
    return lines.join('\n');
  }

  /**
   * Removes sessions older than SESSION_MAX_AGE_DAYS and enforces the
   * MAX_SESSIONS limit. Should be called on startup.
   */
  cleanup(): void {
    try {
      const dir = getSessionsDir();
      if (!fs.existsSync(dir)) {
        return;
      }

      const files = fs.readdirSync(dir).filter(
        (f) => f.endsWith('.json') || f.endsWith('.json.gz'),
      );

      const cutoff = Date.now() - SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

      interface SessionFileInfo {
        filePath: string;
        timestamp: number;
      }

      const sessionFiles: SessionFileInfo[] = [];

      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const stat = fs.statSync(filePath);
          const mtimeMs = stat.mtimeMs;

          if (mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            debugLogger.debug(`Cleaned up old session: ${file}`);
          } else {
            sessionFiles.push({ filePath, timestamp: mtimeMs });
          }
        } catch {
          debugLogger.debug(`Could not stat session file: ${file}`);
        }
      }

      // Enforce max session count
      if (sessionFiles.length > MAX_SESSIONS) {
        sessionFiles.sort((a, b) => b.timestamp - a.timestamp);
        const toRemove = sessionFiles.slice(MAX_SESSIONS);
        for (const { filePath } of toRemove) {
          try {
            fs.unlinkSync(filePath);
            debugLogger.debug(
              `Cleaned up excess session: ${path.basename(filePath)}`,
            );
          } catch {
            // Best effort
          }
        }
      }
    } catch (error) {
      debugLogger.error('Error during session cleanup:', error);
    }
  }

  /**
   * Reads and parses a session file (JSON or gzipped JSON).
   */
  private readSessionFile(filePath: string): PersistedSession | null {
    try {
      let data: string;
      if (filePath.endsWith('.gz')) {
        const compressed = fs.readFileSync(filePath);
        const chunks: Buffer[] = [];
        const gunzip = createGunzip();
        gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
        gunzip.end(compressed);

        // Synchronous decompression via zlib
        const decompressed = gunzipSync(compressed);
        data = decompressed.toString('utf8');
      } else {
        data = fs.readFileSync(filePath, 'utf8');
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion

      const parsed = JSON.parse(data) as PersistedSession;
      if (!parsed.sessionId || !parsed.timestamp) {
        return null;
      }
      return parsed;
    } catch (error) {
      debugLogger.debug(`Failed to read session file ${filePath}:`, error);
      return null;
    }
  }
}
