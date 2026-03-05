/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as Diff from 'diff';

/** ANSI escape helpers */
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const GRAY = '\x1b[90m';

/** Maximum number of diff output lines before truncation. */
const MAX_DIFF_LINES = 50;

/**
 * Generates a colored unified diff string suitable for terminal display.
 *
 * - Additions are shown in green.
 * - Removals are shown in red.
 * - Context lines are shown in gray.
 * - Output is capped at {@link MAX_DIFF_LINES} lines; excess is summarised.
 *
 * @param oldContent The original file content.
 * @param newContent The modified file content.
 * @param filePath   Path used for the diff header.
 * @returns A string containing the ANSI-colored unified diff.
 */
export function formatDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): string {
  const patch = Diff.createPatch(
    filePath,
    oldContent,
    newContent,
    'before',
    'after',
    { context: 3 },
  );

  const rawLines = patch.split('\n');
  const outputLines: string[] = [];

  // Header
  outputLines.push(`${GRAY}--- a/${filePath}${RESET}`);
  outputLines.push(`${GRAY}+++ b/${filePath}${RESET}`);

  // Skip the first 4 header lines that Diff.createPatch emits
  // (===, ---, +++, and potentially an empty line).
  let started = false;
  for (const line of rawLines) {
    if (!started) {
      if (line.startsWith('@@')) {
        started = true;
      } else {
        continue;
      }
    }

    if (line.startsWith('@@')) {
      outputLines.push(`${GRAY}${line}${RESET}`);
    } else if (line.startsWith('+')) {
      outputLines.push(`${GREEN}${line}${RESET}`);
    } else if (line.startsWith('-')) {
      outputLines.push(`${RED}${line}${RESET}`);
    } else {
      outputLines.push(`${GRAY}${line}${RESET}`);
    }
  }

  if (outputLines.length > MAX_DIFF_LINES) {
    const remaining = outputLines.length - MAX_DIFF_LINES;
    const truncated = outputLines.slice(0, MAX_DIFF_LINES);
    truncated.push(`${GRAY}... ${remaining} more lines${RESET}`);
    return truncated.join('\n');
  }

  return outputLines.join('\n');
}
