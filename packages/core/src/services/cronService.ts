/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

/**
 * Represents a parsed time interval in minutes.
 */
export interface ParsedInterval {
  minutes: number;
}

/**
 * Represents the five fields of a parsed cron expression.
 */
export interface CronFields {
  minute: string;
  hour: string;
  dom: string;
  month: string;
  dow: string;
}

/**
 * Represents the status of a cron task.
 */
export type CronTaskStatus = 'active' | 'paused' | 'expired';

/**
 * Represents a scheduled cron task.
 */
export interface CronTask {
  /** Unique 8-character hex identifier. */
  id: string;
  /** Cron expression defining the schedule. */
  cron: string;
  /** The prompt to execute when the task fires. */
  prompt: string;
  /** Whether the task should fire repeatedly. */
  recurring: boolean;
  /** Whether the task survives session restarts. */
  persistent: boolean;
  /** Current status of the task. */
  status: CronTaskStatus;
  /** Timestamp (ms) when the task was created. */
  createdAt: number;
  /** Timestamp (ms) when the task last fired. */
  lastFiredAt?: number;
  /** Number of times this task has fired. */
  fireCount: number;
  /** Timestamp (ms) when the task expires. */
  expiresAt: number;
}

/**
 * Options for creating a new cron task.
 */
export interface CreateTaskOptions {
  /** Cron expression defining the schedule. */
  cron: string;
  /** The prompt to execute when the task fires. */
  prompt: string;
  /** Whether the task should fire repeatedly. Defaults to true. */
  recurring?: boolean;
  /** Whether the task survives session restarts. Defaults to false. */
  persistent?: boolean;
}

/**
 * Configuration for the CronService.
 */
export interface CronServiceConfig {
  /** Maximum number of concurrent tasks. */
  maxConcurrent: number;
  /** Maximum duration (ms) before a task auto-expires. */
  maxDurationMs: number;
  /** Whether the service is enabled. */
  enabled: boolean;
}

/**
 * Events emitted by the CronService.
 */
interface CronServiceEvents {
  'task-due': [CronTask];
  'task-created': [CronTask];
  'task-deleted': [CronTask];
  'task-expired': [CronTask];
}

/** Default interval (10 minutes) when none is specified. */
const DEFAULT_INTERVAL_MINUTES = 10;

/** Three days in milliseconds. */
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Parses a human-readable interval string into minutes.
 *
 * Supported formats:
 * - `'5m'` -> 5 minutes
 * - `'2h'` -> 120 minutes
 * - `'30s'` -> 1 minute (rounds up)
 * - `'1d'` -> 1440 minutes
 * - `undefined` -> 10 minutes (default)
 * - invalid -> null
 */
export function parseInterval(
  input: string | undefined,
): ParsedInterval | null {
  if (input === undefined) {
    return { minutes: DEFAULT_INTERVAL_MINUTES };
  }

  const match = input.trim().match(/^(\d+)\s*([smhd])$/i);
  if (!match) {
    return null;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (value <= 0) {
    return null;
  }

  switch (unit) {
    case 's': {
      const minutes = Math.ceil(value / 60);
      return { minutes };
    }
    case 'm':
      return { minutes: value };
    case 'h':
      return { minutes: value * 60 };
    case 'd':
      return { minutes: value * 1440 };
    default:
      return null;
  }
}

/**
 * Converts a parsed interval to a cron expression string.
 *
 * - Minutes < 60: `'* /N * * * *'` (every N minutes)
 * - Minutes divisible by 60: `'0 * /H * * *'` (every H hours)
 * - Minutes = 1440: `'0 0 * * *'` (daily)
 */
export function intervalToCron(interval: ParsedInterval): string {
  const { minutes } = interval;

  if (minutes >= 1440) {
    return '0 0 * * *';
  }

  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `0 */${hours} * * *`;
  }

  return `*/${minutes} * * * *`;
}

/**
 * Parses a 5-field cron expression string into its constituent fields.
 *
 * @returns The parsed fields, or null if the expression is invalid.
 */
export function parseCronExpression(expr: string): CronFields | null {
  if (!expr || typeof expr !== 'string') {
    return null;
  }

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }

  const cronFieldPattern = /^(\*|\d+)(\/\d+)?(-\d+)?(,\d+)*$/;

  for (const part of parts) {
    if (!cronFieldPattern.test(part)) {
      return null;
    }
  }

  return {
    minute: parts[0],
    hour: parts[1],
    dom: parts[2],
    month: parts[3],
    dow: parts[4],
  };
}

/**
 * Generates a deterministic jitter value (0-59 seconds) from a task ID.
 * This prevents all tasks from firing at exactly the same second.
 */
function jitterFromId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 60;
}

/**
 * Checks whether a cron expression matches the given date (minute-level).
 */
function cronMatchesDate(cron: string, date: Date): boolean {
  const fields = parseCronExpression(cron);
  if (!fields) {
    return false;
  }

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();

  return (
    fieldMatches(fields.minute, minute) &&
    fieldMatches(fields.hour, hour) &&
    fieldMatches(fields.dom, dom) &&
    fieldMatches(fields.month, month) &&
    fieldMatches(fields.dow, dow)
  );
}

/**
 * Checks whether a single cron field matches a given value.
 */
function fieldMatches(field: string, value: number): boolean {
  if (field === '*') {
    return true;
  }

  // Handle step values: */N or N/M
  if (field.includes('/')) {
    const [base, stepStr] = field.split('/');
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) {
      return false;
    }
    const start = base === '*' ? 0 : parseInt(base, 10);
    if (isNaN(start)) {
      return false;
    }
    return (value - start) % step === 0 && value >= start;
  }

  // Handle comma-separated values
  if (field.includes(',')) {
    return field.split(',').some((v) => parseInt(v, 10) === value);
  }

  // Handle ranges
  if (field.includes('-')) {
    const [minStr, maxStr] = field.split('-');
    const min = parseInt(minStr, 10);
    const max = parseInt(maxStr, 10);
    return value >= min && value <= max;
  }

  // Plain number
  return parseInt(field, 10) === value;
}

/**
 * Service for managing scheduled cron tasks. Tasks fire based on cron
 * expressions and emit events that consumers can handle. The service
 * runs a 1-second tick interval to check for due tasks.
 *
 * This service is execution-agnostic — the actual execution of the
 * prompt is handled by the consumer via the 'task-due' event.
 */
export class CronService extends EventEmitter<CronServiceEvents> {
  private tasks: Map<string, CronTask> = new Map();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private config: CronServiceConfig;

  constructor(config?: Partial<CronServiceConfig>) {
    super();
    this.config = {
      maxConcurrent: config?.maxConcurrent ?? 5,
      maxDurationMs: config?.maxDurationMs ?? THREE_DAYS_MS,
      enabled: config?.enabled ?? true,
    };
  }

  /**
   * Creates a new scheduled task.
   *
   * @returns The created task, or null if at max capacity or disabled.
   */
  createTask(options: CreateTaskOptions): CronTask | null {
    if (!this.config.enabled) {
      return null;
    }

    if (this.tasks.size >= this.config.maxConcurrent) {
      return null;
    }

    // Validate the cron expression.
    if (!parseCronExpression(options.cron)) {
      return null;
    }

    const id = randomBytes(4).toString('hex');
    const now = Date.now();

    const task: CronTask = {
      id,
      cron: options.cron,
      prompt: options.prompt,
      recurring: options.recurring ?? true,
      persistent: options.persistent ?? false,
      status: 'active',
      createdAt: now,
      fireCount: 0,
      expiresAt: now + this.config.maxDurationMs,
    };

    this.tasks.set(id, task);
    this.emit('task-created', task);
    return task;
  }

  /**
   * Deletes a task by its ID.
   *
   * @returns True if the task was found and deleted, false otherwise.
   */
  deleteTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) {
      return false;
    }

    this.tasks.delete(id);
    this.emit('task-deleted', task);
    return true;
  }

  /**
   * Returns a task by its ID.
   */
  getTask(id: string): CronTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * Returns all registered tasks.
   */
  getAllTasks(): CronTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Returns all tasks with 'active' status.
   */
  getActiveTasks(): CronTask[] {
    return Array.from(this.tasks.values()).filter((t) => t.status === 'active');
  }

  /**
   * Starts the tick interval that checks for due tasks every second.
   * The interval is unref'd so it does not keep the process alive.
   */
  start(): void {
    if (this.tickInterval) {
      return;
    }

    this.tickInterval = setInterval(() => this.tick(), 1000);
    this.tickInterval.unref();
  }

  /**
   * Stops the tick interval.
   */
  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  /**
   * Sets the busy flag. When busy, due tasks are skipped.
   */
  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  /**
   * Formats the task list for display to the user.
   */
  formatTaskList(): string {
    const allTasks = this.getAllTasks();
    if (allTasks.length === 0) {
      return 'No scheduled tasks.';
    }

    const lines: string[] = ['Scheduled Tasks:'];
    for (const task of allTasks) {
      const statusLabel = task.status.toUpperCase();
      const promptPreview =
        task.prompt.length > 50
          ? task.prompt.substring(0, 47) + '...'
          : task.prompt;
      const recurrence = task.recurring ? 'recurring' : 'one-shot';
      lines.push(
        `  [${statusLabel}] ${task.id} (${task.cron}, ${recurrence}, fired=${task.fireCount}): ${promptPreview}`,
      );
    }

    return lines.join('\n');
  }

  /**
   * Internal tick handler. Called every second to check for due tasks,
   * expire old tasks, and fire events.
   */
  private tick(): void {
    const now = Date.now();
    const currentDate = new Date(now);

    for (const task of this.tasks.values()) {
      // Check for expiration.
      if (now >= task.expiresAt && task.status !== 'expired') {
        task.status = 'expired';
        this.emit('task-expired', task);
        continue;
      }

      // Skip non-active tasks.
      if (task.status !== 'active') {
        continue;
      }

      // Skip if busy.
      if (this.busy) {
        continue;
      }

      // Check if the cron expression matches the current minute.
      if (!cronMatchesDate(task.cron, currentDate)) {
        continue;
      }

      // Prevent double-fires within the same minute window.
      // Use deterministic jitter from the task ID to stagger fires.
      const jitter = jitterFromId(task.id);
      if (currentDate.getSeconds() !== jitter) {
        continue;
      }

      // Prevent firing again if already fired in this minute window.
      if (task.lastFiredAt) {
        const lastFired = new Date(task.lastFiredAt);
        if (
          lastFired.getFullYear() === currentDate.getFullYear() &&
          lastFired.getMonth() === currentDate.getMonth() &&
          lastFired.getDate() === currentDate.getDate() &&
          lastFired.getHours() === currentDate.getHours() &&
          lastFired.getMinutes() === currentDate.getMinutes()
        ) {
          continue;
        }
      }

      // Fire the task.
      task.lastFiredAt = now;
      task.fireCount++;
      this.emit('task-due', task);

      // One-shot tasks self-delete after firing.
      if (!task.recurring) {
        this.tasks.delete(task.id);
        this.emit('task-deleted', task);
      }
    }
  }
}
