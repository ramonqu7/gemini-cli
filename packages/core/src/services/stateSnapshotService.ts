/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tracks structured state (file modifications, current task) across a session
 * so that a snapshot can be appended to the compression prompt. This gives the
 * summariser hard facts it can anchor the snapshot to, even if those facts
 * would otherwise be lost during lossy compression.
 *
 * The service is intentionally lightweight: it records only what the tool
 * pipeline can tell it with certainty (file writes/edits). Decision extraction
 * and current-task inference are left for a future iteration.
 */

/** Maximum number of modified files to include in a snapshot. */
const MAX_FILES_IN_SNAPSHOT = 20;

export class StateSnapshotService {
  private modifiedFiles: Set<string> = new Set();
  private currentTask: string | undefined;

  /**
   * Record that a file was successfully modified (written or edited).
   * Duplicate paths are deduplicated automatically.
   */
  recordFileModification(filePath: string): void {
    this.modifiedFiles.add(filePath);
  }

  /** Returns the set of files modified during this session. */
  getModifiedFiles(): ReadonlySet<string> {
    return this.modifiedFiles;
  }

  /**
   * Optionally set the current high-level task description.
   * This can be called from user-prompt processing in a future iteration.
   */
  setCurrentTask(task: string): void {
    this.currentTask = task;
  }

  /** Returns the current task, if one has been set. */
  getCurrentTask(): string | undefined {
    return this.currentTask;
  }

  /**
   * Generate an XML state-snapshot string suitable for appending to the
   * compression system prompt. Returns `undefined` when there is nothing
   * meaningful to report.
   */
  generateSnapshot(): string | undefined {
    if (this.modifiedFiles.size === 0 && !this.currentTask) {
      return undefined;
    }

    const parts: string[] = ['<state_snapshot_context>'];

    if (this.modifiedFiles.size > 0) {
      const files = [...this.modifiedFiles];
      const truncated = files.length > MAX_FILES_IN_SNAPSHOT;
      const displayFiles = truncated
        ? files.slice(0, MAX_FILES_IN_SNAPSHOT)
        : files;

      parts.push('  <files_modified>');
      for (const f of displayFiles) {
        parts.push(`    ${f}`);
      }
      if (truncated) {
        parts.push(
          `    ... and ${files.length - MAX_FILES_IN_SNAPSHOT} more files`,
        );
      }
      parts.push('  </files_modified>');
    }

    if (this.currentTask) {
      parts.push(`  <current_task>${this.currentTask}</current_task>`);
    }

    parts.push('</state_snapshot_context>');
    return parts.join('\n');
  }

  /** Clear all tracked state. Call on session reset. */
  reset(): void {
    this.modifiedFiles.clear();
    this.currentTask = undefined;
  }
}
