/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';

export const branchCommand: SlashCommand = {
  name: 'branch',
  description:
    'Show conversation waypoints or rewind. Usage: /branch [rewind [N]]',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: (context): SlashCommandActionReturn | void => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not available.',
      };
    }

    const branchService = config.getConversationBranchService();
    const waypointList = branchService.formatWaypointList();

    return {
      type: 'message',
      messageType: 'info',
      content: `Conversation waypoints:\n${waypointList}`,
    };
  },
  subCommands: [
    {
      name: 'rewind',
      description: 'Rewind N turns (default: 1). Usage: /branch rewind [N]',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: (context, args): SlashCommandActionReturn | void => {
        const config = context.services.config;
        if (!config) {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Config not available.',
          };
        }

        const branchService = config.getConversationBranchService();
        const trimmed = args?.trim();
        const n = trimmed ? parseInt(trimmed, 10) : 1;

        if (isNaN(n) || n < 1) {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Usage: /branch rewind [N] where N is a positive integer.',
          };
        }

        const result = branchService.rewindByN(n);
        if (!result) {
          return {
            type: 'message',
            messageType: 'error',
            content: `Cannot rewind ${n} turn(s). Only ${branchService.getTurnCount()} turn(s) recorded.`,
          };
        }

        const client = config.getGeminiClient();
        if (!client) {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Client not initialized.',
          };
        }

        client.setHistory(result.history);

        return {
          type: 'message',
          messageType: 'info',
          content: `Rewound ${n} turn(s) to turn ${result.waypoint.turnIndex}: "${result.waypoint.messagePreview}"`,
        };
      },
    },
  ],
};
