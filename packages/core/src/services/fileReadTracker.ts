/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

/**
 * Tracks which files have been read during the current session.
 * Used to warn when the model tries to overwrite a file it hasn't
 * read, which is the #1 cause of lost code — the model writes what
 * it thinks the file contains, missing changes made by other tools
 * or by the user.
 */
export class FileReadTracker {
  private readFiles: Set<string> = new Set();

  /**
   * Record that a file was read or its content was seen by the model.
   * The path is normalized to an absolute path for consistent tracking.
   */
  recordRead(filePath: string): void {
    this.readFiles.add(path.resolve(filePath));
  }

  /**
   * Check if a file was read in this session.
   * @returns true if the file has been read/seen, false otherwise.
   */
  wasRead(filePath: string): boolean {
    return this.readFiles.has(path.resolve(filePath));
  }

  /**
   * Clear all tracking state (e.g., on /clear or session reset).
   */
  reset(): void {
    this.readFiles.clear();
  }
}
