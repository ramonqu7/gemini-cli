/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getGlobalMemoryFilePath } from '../tools/memoryTool.js';
import { debugLogger } from '../utils/debugLogger.js';

const AUTO_MEMORY_SECTION_HEADER = '## Auto Memories';
const MAX_AUTO_MEMORY_LINES = 200;

/**
 * Patterns that indicate a user correction or preference expression.
 * When detected, the system should auto-save the learning.
 */
const CORRECTION_PATTERNS = [
  /no[,.]?\s+(actually|instead|use|don't|do not|it should|that's wrong|that's not)/i,
  /actually[,.]?\s+(it|you|we|the|I|use|don't)/i,
  /that's\s+(wrong|incorrect|not right|not what)/i,
  /please\s+(always|never|don't|do not|remember|use)/i,
  /always\s+(use|prefer|do|make|keep|run)/i,
  /never\s+(use|do|make|run|delete)/i,
  /I\s+prefer\s+/i,
  /from now on[,.]?\s+/i,
  /going forward[,.]?\s+/i,
  /remember\s+(that|to|this)/i,
  /don't forget\s+(that|to)/i,
  /the correct\s+(way|approach|method|command)/i,
  /instead of\s+.+[,.]?\s+(use|try|do)/i,
];

/**
 * Detects if a user message contains a correction or preference.
 */
export function isCorrection(text: string): boolean {
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Extracts the core learning from a user correction message.
 * Returns a concise fact suitable for memory storage.
 */
function extractLearning(userMessage: string, _modelResponse?: string): string {
  // Clean up the message - take the most relevant sentence
  const sentences = userMessage
    .split(/[.!?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);

  // Find the sentence with a correction pattern
  for (const sentence of sentences) {
    if (CORRECTION_PATTERNS.some((p) => p.test(sentence))) {
      return sentence.replace(/^(no[,.]?\s*|actually[,.]?\s*)/i, '').trim();
    }
  }

  // Fallback: use the first meaningful sentence
  return sentences[0] || userMessage.slice(0, 200).trim();
}

/**
 * Reads the current auto memories from the memory file.
 */
async function readAutoMemories(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const headerIndex = content.indexOf(AUTO_MEMORY_SECTION_HEADER);
    if (headerIndex === -1) return [];

    const sectionStart = headerIndex + AUTO_MEMORY_SECTION_HEADER.length;
    let sectionEnd = content.indexOf('\n## ', sectionStart);
    if (sectionEnd === -1) sectionEnd = content.length;

    const sectionContent = content.substring(sectionStart, sectionEnd).trim();
    return sectionContent.split('\n').filter((line) => line.startsWith('- '));
  } catch {
    return [];
  }
}

/**
 * Appends an auto memory entry to the memory file.
 * Prunes oldest entries if exceeding MAX_AUTO_MEMORY_LINES.
 */
async function appendAutoMemory(filePath: string, fact: string): Promise<void> {
  const date = new Date().toISOString().split('T')[0];
  const sanitizedFact = fact.replace(/[\r\n]/g, ' ').trim();
  const newEntry = `- [${date}] ${sanitizedFact}`;

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    content = '';
  }

  const headerIndex = content.indexOf(AUTO_MEMORY_SECTION_HEADER);

  if (headerIndex === -1) {
    // Append new section
    const separator =
      content.length > 0 && !content.endsWith('\n\n')
        ? content.endsWith('\n')
          ? '\n'
          : '\n\n'
        : '';
    content += `${separator}${AUTO_MEMORY_SECTION_HEADER}\n${newEntry}\n`;
  } else {
    const sectionStart = headerIndex + AUTO_MEMORY_SECTION_HEADER.length;
    let sectionEnd = content.indexOf('\n## ', sectionStart);
    if (sectionEnd === -1) sectionEnd = content.length;

    const beforeSection = content.substring(0, sectionStart).trimEnd();
    let sectionContent = content.substring(sectionStart, sectionEnd).trimEnd();
    const afterSection = content.substring(sectionEnd);

    // Add new entry
    sectionContent += `\n${newEntry}`;

    // Prune if over limit
    const lines = sectionContent.split('\n').filter((l) => l.startsWith('- '));
    if (lines.length > MAX_AUTO_MEMORY_LINES) {
      const prunedLines = lines.slice(lines.length - MAX_AUTO_MEMORY_LINES);
      sectionContent = '\n' + prunedLines.join('\n');
    }

    content =
      `${beforeSection}\n${sectionContent.trimStart()}\n${afterSection}`.trimEnd() +
      '\n';
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

/**
 * Checks if a duplicate or very similar memory already exists.
 */
function isDuplicate(existing: string[], newFact: string): boolean {
  const normalized = newFact.toLowerCase().replace(/\s+/g, ' ').trim();
  return existing.some((line) => {
    // Remove the date prefix and "- " marker
    const existingFact = line
      .replace(/^-\s*\[\d{4}-\d{2}-\d{2}\]\s*/, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    // Check for high similarity (>80% overlap)
    return (
      normalized === existingFact ||
      normalized.includes(existingFact) ||
      existingFact.includes(normalized)
    );
  });
}

/**
 * Auto Memory Service.
 * Detects user corrections and preferences from conversation,
 * and automatically saves them to the GEMINI.md memory file.
 */
export class AutoMemoryService {
  private enabled: boolean;

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Process a conversation turn to detect and save corrections.
   * Call this after each user message + model response pair.
   */
  async processConversationTurn(
    userMessage: string,
    modelResponse?: string,
  ): Promise<string | null> {
    if (!this.enabled) return null;

    // Check if the user message contains a correction
    if (!isCorrection(userMessage)) return null;

    const filePath = getGlobalMemoryFilePath();
    const learning = extractLearning(userMessage, modelResponse);

    if (!learning || learning.length < 10) return null;

    // Check for duplicates
    const existing = await readAutoMemories(filePath);
    if (isDuplicate(existing, learning)) {
      debugLogger.debug('Auto memory: skipping duplicate learning:', learning);
      return null;
    }

    try {
      await appendAutoMemory(filePath, learning);
      debugLogger.debug('Auto memory: saved learning:', learning);
      return learning;
    } catch (error) {
      debugLogger.debug('Auto memory: failed to save:', error);
      return null;
    }
  }
}
