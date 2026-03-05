/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { exportConversationToMarkdown } from '@google/gemini-cli-core';
import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';

export const exportCommand: SlashCommand = {
  name: 'export',
  description: 'Export conversation to markdown. Usage: /export [filename]',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    const client = context.services.config?.getGeminiClient();
    if (!client) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No active session to export.',
      };
    }

    const chat = client.getChat();
    const history = chat.getHistory();

    if (!history || history.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'No conversation history to export.',
      };
    }

    const model = context.services.config?.getModel() ?? 'unknown';
    const filename = args?.trim() || undefined;

    try {
      const filePath = exportConversationToMarkdown(history, model, filename);
      return {
        type: 'message',
        messageType: 'info',
        content: `Conversation exported to ${filePath}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to export conversation: ${message}`,
      };
    }
  },
};
