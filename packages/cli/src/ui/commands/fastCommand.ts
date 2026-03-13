/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  PREVIEW_GEMINI_3_1_MODEL,
  PREVIEW_GEMINI_3_1_FLASH_MODEL,
  getDisplayString,
  ModelSlashCommandEvent,
  logModelSlashCommand,
} from '@google/gemini-cli-core';
import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
} from './types.js';
import { MessageType } from '../types.js';

/** Stores the model the user was on before toggling to fast mode. */
let previousModel: string | null = null;

/**
 * `/fast` — toggle between flash (fast) and pro (quality) models mid-conversation.
 *
 * The command remembers the model the user was on, so running `/fast` again
 * switches back.  Conversation history is preserved; only the model changes.
 */
export const fastCommand: SlashCommand = {
  name: 'fast',
  description: 'Toggle between flash (fast) and pro (quality) models',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context: CommandContext) => {
    const config = context.services.config;
    if (!config) {
      context.ui.addItem({
        type: MessageType.ERROR,
        text: 'Configuration not available.',
      });
      return;
    }

    const currentModel = config.getModel();
    const isCurrentlyFlash = currentModel.toLowerCase().includes('flash');

    let newModel: string;
    let modeLabel: string;

    if (isCurrentlyFlash) {
      // Switch back to the previous model, or default pro.
      newModel = previousModel ?? PREVIEW_GEMINI_3_1_MODEL;
      previousModel = null;
      modeLabel = 'quality mode';
    } else {
      // Remember the current model and switch to flash.
      previousModel = currentModel;
      newModel = PREVIEW_GEMINI_3_1_FLASH_MODEL;
      modeLabel = 'fast mode';
    }

    config.setModel(newModel, /* isTemporary */ true);

    const event = new ModelSlashCommandEvent(newModel);
    logModelSlashCommand(config, event);

    context.ui.addItem({
      type: MessageType.INFO,
      text: `Switched to ${getDisplayString(newModel)} (${modeLabel})`,
    });
  },
};
