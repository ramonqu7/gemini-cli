/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand, type CommandContext } from './types.js';
import { MessageType } from '../types.js';
import {
  BackgroundTaskService,
  GeminiClient,
  GeminiEventType,
  coreEvents,
  type BackgroundTask,
} from '@google/gemini-cli-core';

/**
 * Singleton BackgroundTaskService instance shared across the CLI session.
 */
let backgroundTaskServiceInstance: BackgroundTaskService | null = null;

function getBackgroundTaskService(): BackgroundTaskService {
  if (!backgroundTaskServiceInstance) {
    backgroundTaskServiceInstance = new BackgroundTaskService();
  }
  return backgroundTaskServiceInstance;
}

/**
 * Executes a prompt as a background task using a separate GeminiClient.
 * The task runs concurrently with the main session and notifications
 * are emitted via the core event system when completed.
 */
async function executeBackgroundTask(
  context: CommandContext,
  taskId: string,
  prompt: string,
): Promise<void> {
  const service = getBackgroundTaskService();
  const config = context.services.config;

  if (!config) {
    service.failTask(taskId, 'Config not available.');
    return;
  }

  // Create an independent GeminiClient for this background task.
  const bgClient = new GeminiClient(config);

  try {
    await bgClient.initialize();
    await bgClient.addDirectoryContext();

    const abortController = new AbortController();
    const promptId = `bg-${taskId}-${Date.now()}`;

    // Collect the model's response text from the stream events.
    let responseText = '';

    const stream = bgClient.sendMessageStream(
      prompt,
      abortController.signal,
      promptId,
    );

    for await (const event of stream) {
      if (
        event.type === GeminiEventType.Content &&
        'value' in event &&
        typeof event.value === 'string'
      ) {
        responseText += event.value;
      }
    }

    // Truncate result for the summary notification; full result available via
    // /bg results <id>.
    const resultSummary = responseText.trim() || 'Task completed (no output).';
    service.completeTask(taskId, resultSummary);

    // Notify the UI via core events.
    const task = service.getTask(taskId);
    if (task) {
      coreEvents.emitBackgroundTaskCompleted(task);
    }
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : 'Unknown error occurred.';
    service.failTask(taskId, errorMsg);

    const task = service.getTask(taskId);
    if (task) {
      coreEvents.emitBackgroundTaskCompleted(task);
    }
  } finally {
    bgClient.dispose();
  }
}

/**
 * /bg — list all background tasks
 */
const bgListAction = async (context: CommandContext): Promise<void> => {
  const service = getBackgroundTaskService();
  const text = service.formatTaskList();
  context.ui.addItem({ type: MessageType.INFO, text });
};

/**
 * /bg results <id> — show full results of a completed task
 */
const bgResultsAction = async (
  context: CommandContext,
  args: string,
): Promise<void> => {
  const service = getBackgroundTaskService();
  const taskId = args.trim();

  if (!taskId) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Usage: /bg results <task-id>',
    });
    return;
  }

  const task = service.getTask(taskId);
  if (!task) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: `No background task found with ID "${taskId}".`,
    });
    return;
  }

  if (task.status === 'running') {
    const elapsed = Math.floor((Date.now() - task.startTime) / 1000);
    context.ui.addItem({
      type: MessageType.INFO,
      text: `Task ${task.id} is still running (${elapsed}s elapsed).\nPrompt: "${task.description}"`,
    });
    return;
  }

  if (task.status === 'failed') {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: `Task ${task.id} failed.\nPrompt: "${task.description}"\nError: ${task.error || 'Unknown error'}`,
    });
    return;
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Task ${task.id} completed.\nPrompt: "${task.description}"\n\nResult:\n${task.result || 'No output.'}`,
  });
};

/**
 * /bg <prompt> — start a new background task
 */
const bgStartAction = async (
  context: CommandContext,
  args: string,
): Promise<void> => {
  const prompt = args.trim();
  if (!prompt) {
    // No prompt provided — show task list
    return bgListAction(context);
  }

  const service = getBackgroundTaskService();
  const taskId = service.createTask(prompt);

  if (!taskId) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: `Maximum concurrent background tasks (3) reached. Wait for a task to complete or check status with /bg.`,
    });
    return;
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Background task ${taskId} started: "${prompt.length > 80 ? prompt.substring(0, 77) + '...' : prompt}"\nUse /bg to check status, /bg results ${taskId} to see results when complete.`,
  });

  // Fire and forget — the task runs in the background.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  executeBackgroundTask(context, taskId, prompt);
};

const bgResultsCommand: SlashCommand = {
  name: 'results',
  description: 'Show results of a completed background task',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: bgResultsAction,
  completion: (_context: CommandContext, partialArg: string) => {
    const service = getBackgroundTaskService();
    const completedTasks = service.getCompletedTasks();
    return completedTasks
      .map((t: BackgroundTask) => t.id)
      .filter((id: string) => id.startsWith(partialArg));
  },
  showCompletionLoading: false,
};

const bgListCommand: SlashCommand = {
  name: 'list',
  description: 'List all background tasks and their status',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: bgListAction,
};

export const bgCommand: SlashCommand = {
  name: 'bg',
  description: 'Run tasks in the background (/bg <prompt> to start)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [bgListCommand, bgResultsCommand],
  action: bgStartAction,
};

/**
 * Returns the singleton BackgroundTaskService for use by other UI components
 * (e.g., notification display).
 */
export { getBackgroundTaskService };
