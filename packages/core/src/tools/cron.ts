/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import type { CronService} from '../services/cronService.js';
import { parseCronExpression } from '../services/cronService.js';

export interface CronCreateArgs {
  cron_expression: string;
  prompt: string;
  recurring?: boolean;
  persistent?: boolean;
}

export interface CronCreateResult {
  success: boolean;
  taskId?: string;
  schedule?: string;
  error?: string;
}

export interface CronDeleteArgs {
  task_id: string;
}

export interface CronDeleteResult {
  success: boolean;
  error?: string;
}

/**
 * Creates a new cron task after validating the cron expression.
 *
 * @returns A result object with success status, task ID/schedule on success,
 *          or an error message on failure.
 */
export function handleCronCreate(
  cronService: CronService,
  args: CronCreateArgs,
): CronCreateResult {
  const parsed = parseCronExpression(args.cron_expression);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid cron expression: "${args.cron_expression}". Expected 5 space-separated fields (minute hour dom month dow).`,
    };
  }

  const task = cronService.createTask({
    cron: args.cron_expression,
    prompt: args.prompt,
    recurring: args.recurring,
    persistent: args.persistent,
  });

  if (!task) {
    return {
      success: false,
      error:
        'Maximum number of concurrent tasks reached. Delete an existing task before creating a new one.',
    };
  }

  return {
    success: true,
    taskId: task.id,
    schedule: task.cron,
  };
}

/**
 * Returns a formatted string listing all scheduled cron tasks.
 */
export function handleCronList(cronService: CronService): string {
  return cronService.formatTaskList();
}

/**
 * Deletes a cron task by its ID.
 *
 * @returns A result object with success status or an error message.
 */
export function handleCronDelete(
  cronService: CronService,
  args: CronDeleteArgs,
): CronDeleteResult {
  const deleted = cronService.deleteTask(args.task_id);
  if (!deleted) {
    return {
      success: false,
      error: `Task "${args.task_id}" not found.`,
    };
  }

  return { success: true };
}
