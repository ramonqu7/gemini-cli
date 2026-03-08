/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import {
  parseInterval,
  intervalToCron,
  type CronService,
} from '@google/gemini-cli-core';
import {
  CommandKind,
  type SlashCommand,
  type CommandContext,
} from './types.js';
import { MessageType } from '../types.js';

/**
 * Result of parsing `/loop` arguments.
 */
export interface ParsedLoopArgs {
  interval: string | undefined;
  prompt: string;
}

/**
 * Interval pattern: digits followed by a time unit suffix (s/m/h/d).
 */
const INTERVAL_RE = /^\d+[smhd]$/i;

/**
 * Trailing "every <interval>" clause pattern.
 */
const TRAILING_EVERY_RE = /\s+every\s+(\d+[smhd])\s*$/i;

/**
 * Parses the raw argument string for the `/loop` command.
 *
 * Supports three forms:
 * - Leading interval:  `"5m check the build"` -> interval='5m', prompt='check the build'
 * - Trailing every:    `"check the build every 2h"` -> interval='2h', prompt='check the build'
 * - No interval:       `"check the build"` -> interval=undefined, prompt='check the build'
 * - Empty:             `""` -> interval=undefined, prompt=''
 */
export function parseLoopArgs(input: string): ParsedLoopArgs {
  const trimmed = input.trim();

  if (!trimmed) {
    return { interval: undefined, prompt: '' };
  }

  // Check for a leading interval token (e.g. "5m check the build").
  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace !== -1) {
    const firstToken = trimmed.substring(0, firstSpace);
    if (INTERVAL_RE.test(firstToken)) {
      return {
        interval: firstToken,
        prompt: trimmed.substring(firstSpace + 1).trim(),
      };
    }
  }

  // Check for a trailing "every <interval>" clause.
  const trailingMatch = trimmed.match(TRAILING_EVERY_RE);
  if (trailingMatch) {
    return {
      interval: trailingMatch[1],
      prompt: trimmed.substring(0, trailingMatch.index).trim(),
    };
  }

  // No interval found — the entire input is the prompt.
  return { interval: undefined, prompt: trimmed };
}

/**
 * Helper to retrieve the CronService from the command context.
 * Returns null if the service is unavailable.
 */
function getCronService(context: CommandContext): CronService | null {
  const config = context.services.config as
    | (typeof context.services.config & {
        getCronService?: () => CronService | null;
      })
    | null;
  return config?.getCronService?.() ?? null;
}

/**
 * /loop list — display all scheduled tasks.
 */
const loopListAction = async (context: CommandContext): Promise<void> => {
  const cronService = getCronService(context);
  if (!cronService) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Scheduled tasks are not enabled.',
    });
    return;
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: cronService.formatTaskList(),
  });
};

/**
 * /loop cancel <id> — cancel a scheduled task.
 */
const loopCancelAction = async (
  context: CommandContext,
  args: string,
): Promise<void> => {
  const cronService = getCronService(context);
  if (!cronService) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Scheduled tasks are not enabled.',
    });
    return;
  }

  const taskId = args.trim();
  if (!taskId) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Usage: /loop cancel <task-id>',
    });
    return;
  }

  const deleted = cronService.deleteTask(taskId);
  if (!deleted) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: `No scheduled task found with ID "${taskId}".`,
    });
    return;
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Cancelled scheduled task ${taskId}.`,
  });
};

/**
 * /loop [interval] <prompt> — create a new recurring task, or list tasks if no args.
 */
const loopMainAction = async (
  context: CommandContext,
  args: string,
): Promise<void> => {
  const trimmedArgs = args.trim();

  // No arguments — show task list.
  if (!trimmedArgs) {
    return loopListAction(context);
  }

  const cronService = getCronService(context);
  if (!cronService) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Scheduled tasks are not enabled.',
    });
    return;
  }

  const parsed = parseLoopArgs(trimmedArgs);

  if (!parsed.prompt) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'A prompt is required. Usage: /loop [interval] <prompt>',
    });
    return;
  }

  // Parse the interval (undefined uses the default from parseInterval).
  const interval = parseInterval(parsed.interval);
  if (!interval) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: `Invalid interval "${parsed.interval}". Use formats like 5m, 2h, 1d.`,
    });
    return;
  }

  const cron = intervalToCron(interval);
  const task = cronService.createTask({ cron, prompt: parsed.prompt });

  if (!task) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Could not create task. Maximum number of scheduled tasks may have been reached.',
    });
    return;
  }

  // Build a human-readable interval label.
  const intervalLabel = parsed.interval ?? '10m';
  context.ui.addItem({
    type: MessageType.INFO,
    text: `Scheduled task ${task.id}: "${parsed.prompt}" every ${intervalLabel}\nUse /loop to list tasks, /loop cancel ${task.id} to remove.`,
  });
};

const loopListCommand: SlashCommand = {
  name: 'list',
  description: 'List all scheduled recurring tasks',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: loopListAction,
};

const loopCancelCommand: SlashCommand = {
  name: 'cancel',
  description: 'Cancel a scheduled recurring task',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: loopCancelAction,
};

export const loopCommand: SlashCommand = {
  name: 'loop',
  description: 'Schedule recurring tasks (/loop [interval] <prompt>)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [loopListCommand, loopCancelCommand],
  action: loopMainAction,
};
