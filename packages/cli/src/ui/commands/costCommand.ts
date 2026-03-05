/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { tokenBudgetService } from '@google/gemini-cli-core';
import { MessageType } from '../types.js';
import { formatDuration } from '../utils/formatters.js';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';

export const costCommand: SlashCommand = {
  name: 'cost',
  description: 'Show session token usage and estimated cost',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (context: CommandContext) => {
    if (!tokenBudgetService.isEnabled()) {
      context.ui.addItem({
        type: MessageType.INFO,
        text: 'Token tracking is disabled. Enable it in settings to see cost data.',
      });
      return;
    }

    const now = new Date();
    const { sessionStartTime } = context.session.stats;
    let durationLine = '';
    if (sessionStartTime) {
      const wallDuration = now.getTime() - sessionStartTime.getTime();
      durationLine = `\n  Duration: ${formatDuration(wallDuration)}`;
    }

    const progressBar = tokenBudgetService.getProgressBar(40);
    const detailed = tokenBudgetService.formatDetailedBudget();

    const output = [
      detailed,
      `  Context:  ${progressBar}`,
      `${durationLine}`,
    ]
      .filter(Boolean)
      .join('\n');

    context.ui.addItem({
      type: MessageType.INFO,
      text: output,
    });
  },
};
