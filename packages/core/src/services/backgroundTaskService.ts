/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { notifyTaskComplete } from './notificationService.js';

/**
 * Represents the status of a background task.
 */
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed';

/**
 * Represents a single background task that runs independently from the
 * main conversation loop.
 */
export interface BackgroundTask {
  /** Unique identifier for the task. */
  id: string;
  /** User-provided description or prompt for the task. */
  description: string;
  /** Current execution status. */
  status: BackgroundTaskStatus;
  /** Timestamp (ms) when the task was created. */
  startTime: number;
  /** Timestamp (ms) when the task completed or failed. */
  endTime?: number;
  /** The result summary if completed. */
  result?: string;
  /** The error message if failed. */
  error?: string;
}

/**
 * Events emitted by the BackgroundTaskService.
 */
interface BackgroundTaskEvents {
  'task-completed': [BackgroundTask];
  'task-failed': [BackgroundTask];
  'task-created': [BackgroundTask];
}

/**
 * Maximum number of concurrent background tasks.
 */
const MAX_CONCURRENT_TASKS = 3;

/**
 * Service for managing background tasks that run concurrently with the
 * main interactive session. Background tasks execute prompts in separate
 * agent contexts and notify the user upon completion.
 *
 * This service is intentionally model-agnostic and execution-agnostic.
 * The actual execution of tasks is handled by the consumer (CLI layer)
 * which has access to the GeminiClient and agent infrastructure.
 */
export class BackgroundTaskService extends EventEmitter<BackgroundTaskEvents> {
  private tasks: Map<string, BackgroundTask> = new Map();
  private nextTaskId = 1;
  private desktopNotificationsEnabled = false;

  /**
   * Enables or disables desktop notifications for task completion.
   * When enabled, an OS-level notification is sent for tasks that
   * took longer than 30 seconds.
   */
  setDesktopNotifications(enabled: boolean): void {
    this.desktopNotificationsEnabled = enabled;
  }

  /**
   * Creates a new background task entry and returns its ID.
   * The caller is responsible for actually executing the task.
   *
   * @param description The user-provided prompt or description.
   * @returns The task ID, or null if the maximum number of concurrent tasks
   *          has been reached.
   */
  createTask(description: string): string | null {
    const runningCount = this.getRunningTasks().length;
    if (runningCount >= MAX_CONCURRENT_TASKS) {
      return null;
    }

    const id = `bg-${this.nextTaskId++}`;
    const task: BackgroundTask = {
      id,
      description,
      status: 'running',
      startTime: Date.now(),
    };

    this.tasks.set(id, task);
    this.emit('task-created', task);
    return id;
  }

  /**
   * Marks a task as completed with a result summary.
   */
  completeTask(id: string, result: string): void {
    const task = this.tasks.get(id);
    if (!task) {
      return;
    }

    task.status = 'completed';
    task.endTime = Date.now();
    task.result = result;
    this.emit('task-completed', task);

    // Fire-and-forget desktop notification for long-running tasks (>30s).
    const durationMs = task.endTime - task.startTime;
    if (this.desktopNotificationsEnabled && durationMs > 30_000) {
      const descPreview =
        task.description.length > 60
          ? task.description.substring(0, 57) + '...'
          : task.description;
      notifyTaskComplete(descPreview, durationMs);
    }
  }

  /**
   * Marks a task as failed with an error message.
   */
  failTask(id: string, error: string): void {
    const task = this.tasks.get(id);
    if (!task) {
      return;
    }

    task.status = 'failed';
    task.endTime = Date.now();
    task.error = error;
    this.emit('task-failed', task);
  }

  /**
   * Returns a task by its ID.
   */
  getTask(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * Returns all currently running tasks.
   */
  getRunningTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.status === 'running',
    );
  }

  /**
   * Returns all completed tasks (both successful and failed).
   */
  getCompletedTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.status !== 'running',
    );
  }

  /**
   * Returns all tasks regardless of status.
   */
  getAllTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Formats a duration in milliseconds to a human-readable string.
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }

  /**
   * Formats the task list for display to the user.
   */
  formatTaskList(): string {
    const allTasks = this.getAllTasks();
    if (allTasks.length === 0) {
      return 'No background tasks.';
    }

    const lines: string[] = ['Background Tasks:'];
    for (const task of allTasks) {
      const duration = task.endTime
        ? this.formatDuration(task.endTime - task.startTime)
        : this.formatDuration(Date.now() - task.startTime);

      let statusIcon: string;
      switch (task.status) {
        case 'running':
          statusIcon = '...';
          break;
        case 'completed':
          statusIcon = 'OK';
          break;
        case 'failed':
          statusIcon = 'FAIL';
          break;
        default:
          statusIcon = '?';
          break;
      }

      const descPreview =
        task.description.length > 60
          ? task.description.substring(0, 57) + '...'
          : task.description;

      lines.push(`  [${statusIcon}] ${task.id} (${duration}): ${descPreview}`);
    }

    return lines.join('\n');
  }

  /**
   * Formats a notification message for a completed or failed task.
   */
  formatNotification(task: BackgroundTask): string {
    const duration = task.endTime
      ? this.formatDuration(task.endTime - task.startTime)
      : 'unknown';

    if (task.status === 'completed') {
      const resultPreview = task.result
        ? task.result.length > 200
          ? task.result.substring(0, 197) + '...'
          : task.result
        : 'No result details.';
      return [
        `--- Background task completed (${duration}) ---`,
        `Task: "${task.description}"`,
        `Result: ${resultPreview}`,
        `Use /bg results ${task.id} to see full details`,
        `${'---'.repeat(14)}`,
      ].join('\n');
    }

    return [
      `--- Background task failed (${duration}) ---`,
      `Task: "${task.description}"`,
      `Error: ${task.error || 'Unknown error'}`,
      `${'---'.repeat(14)}`,
    ].join('\n');
  }
}
