/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Content } from '@google/genai';
import { homedir, GEMINI_DIR } from '../utils/paths.js';

/**
 * Directory for conversation exports: ~/.gemini/exports/
 */
function getExportsDir(): string {
  return path.join(homedir(), GEMINI_DIR, 'exports');
}

/**
 * Ensures the exports directory exists.
 */
function ensureExportsDir(): void {
  const dir = getExportsDir();
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Formats a Content entry's parts into markdown text.
 */
function formatParts(parts: Content['parts']): string {
  if (!parts || parts.length === 0) {
    return '_No content_';
  }

  const sections: string[] = [];

  for (const part of parts) {
    if (part.thought && part.text) {
      sections.push(`> *Thinking:* ${part.text.trim()}`);
    } else if (part.text) {
      sections.push(part.text.trim());
    } else if (part.functionCall) {
      const args = part.functionCall.args
        ? JSON.stringify(part.functionCall.args, null, 2)
        : '';
      const preview =
        args.length > 500 ? args.substring(0, 500) + '\n...' : args;
      sections.push(
        `### Tool Call: ${part.functionCall.name ?? 'unknown'}\n` +
          '```json\n' +
          preview +
          '\n```',
      );
    } else if (part.functionResponse) {
      const name = part.functionResponse.name ?? 'unknown';
      const response = part.functionResponse.response;
      let outputStr: string;
      if (typeof response === 'string') {
        outputStr = response;
      } else if (response && typeof response === 'object') {
        if ('output' in response && typeof response['output'] === 'string') {
          outputStr = response['output'];
        } else {
          outputStr = JSON.stringify(response, null, 2);
        }
      } else {
        outputStr = String(response);
      }

      const lineCount = outputStr.split('\n').length;
      const truncated =
        outputStr.length > 1000
          ? outputStr.substring(0, 1000) + '\n...(truncated)'
          : outputStr;

      sections.push(
        `### Tool: ${name}\n` +
          `<details><summary>Output (${lineCount} lines)</summary>\n\n` +
          '```\n' +
          truncated +
          '\n```\n' +
          '</details>',
      );
    }
  }

  return sections.join('\n\n');
}

/**
 * Exports a conversation history to a markdown file.
 *
 * @param history - The conversation history (Content[]) to export.
 * @param model - The model name used in this session.
 * @param filename - Optional filename (without extension). Defaults to timestamp.
 * @returns The absolute path of the exported file.
 */
export function exportConversationToMarkdown(
  history: readonly Content[],
  model: string,
  filename?: string,
): string {
  ensureExportsDir();

  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .replace('Z', '');
  const baseName = filename?.trim() || timestamp;
  const safeName = baseName.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const filePath = path.join(getExportsDir(), `${safeName}.md`);

  const dateStr = now.toISOString().replace('T', ' ').replace('Z', ' UTC');

  const lines: string[] = [
    '# Gemini CLI Conversation',
    '',
    `Date: ${dateStr}`,
    `Model: ${model}`,
    `Turns: ${history.length}`,
    '',
    '---',
    '',
  ];

  for (const entry of history) {
    const role = entry.role === 'user' ? 'User' : 'Assistant';
    lines.push(`## ${role}`);
    lines.push('');
    lines.push(formatParts(entry.parts));
    lines.push('');
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}
