/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { getGlobalMemoryFilePath } from '../tools/memoryTool.js';
import { debugLogger } from '../utils/debugLogger.js';

const COMPACT_INSTRUCTIONS_HEADER = '## Compact Instructions';

/**
 * Reads custom compact/compression instructions from the GEMINI.md file.
 * Users can add a "## Compact Instructions" section to guide what to preserve
 * during context compression.
 *
 * Example in GEMINI.md:
 * ```
 * ## Compact Instructions
 * Focus on code changes and test results.
 * Always preserve file paths and error messages.
 * Prioritize keeping API endpoint details.
 * ```
 */
export async function readCompactInstructions(): Promise<string | undefined> {
  try {
    const filePath = getGlobalMemoryFilePath();
    const content = await fs.readFile(filePath, 'utf-8');

    const headerIndex = content.indexOf(COMPACT_INSTRUCTIONS_HEADER);
    if (headerIndex === -1) return undefined;

    const sectionStart = headerIndex + COMPACT_INSTRUCTIONS_HEADER.length;
    let sectionEnd = content.indexOf('\n## ', sectionStart);
    if (sectionEnd === -1) sectionEnd = content.length;

    const instructions = content.substring(sectionStart, sectionEnd).trim();
    if (!instructions) return undefined;

    debugLogger.debug('Found compact instructions:', instructions);
    return instructions;
  } catch {
    return undefined;
  }
}

/**
 * Merges user-provided compact instructions (from /compact command)
 * with instructions from GEMINI.md.
 */
export async function getEffectiveCompactInstructions(
  userInstructions?: string,
): Promise<string | undefined> {
  const fileInstructions = await readCompactInstructions();

  if (userInstructions && fileInstructions) {
    return `${fileInstructions}\n\nAdditional instructions for this compression:\n${userInstructions}`;
  }

  return userInstructions || fileInstructions;
}
