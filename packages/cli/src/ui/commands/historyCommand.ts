/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandHistoryService } from '@google/gemini-cli-core';
import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';

function formatEntry(entry: { timestamp: string; prompt: string; model: string }): string {
  const date = new Date(entry.timestamp);
  const dateStr = date.toLocaleString();
  const truncatedPrompt =
    entry.prompt.length > 100
      ? entry.prompt.substring(0, 100) + '...'
      : entry.prompt;
  return `[${dateStr}] (${entry.model}) ${truncatedPrompt}`;
}

export const historyCommand: SlashCommand = {
  name: 'history',
  description: 'Show or search command history. Usage: /history [search <query>]',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: (_context, args): SlashCommandActionReturn | void => {
    const service = new CommandHistoryService();
    const entries = service.getHistory(20);

    if (entries.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'No command history found.',
      };
    }

    const formatted = entries.map(formatEntry).join('\n');
    return {
      type: 'message',
      messageType: 'info',
      content: `Recent prompts (${entries.length}):\n${formatted}`,
    };
  },
  subCommands: [
    {
      name: 'search',
      description: 'Search command history by keyword',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: (_context, args): SlashCommandActionReturn | void => {
        const query = args?.trim();
        if (!query) {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Usage: /history search <query>',
          };
        }

        const service = new CommandHistoryService();
        const results = service.searchHistory(query, 20);

        if (results.length === 0) {
          return {
            type: 'message',
            messageType: 'info',
            content: `No history entries matching "${query}".`,
          };
        }

        const formatted = results.map(formatEntry).join('\n');
        return {
          type: 'message',
          messageType: 'info',
          content: `Search results for "${query}" (${results.length}):\n${formatted}`,
        };
      },
    },
  ],
};
