/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared task list for agent team coordination.
 * Backed by a JSON file on disk with filesystem-level locking to prevent
 * race conditions when multiple agent processes access the task list concurrently.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface TeamTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  dependencies: string[];
  result?: string;
  error?: string;
}

export interface SharedTaskListOptions {
  /** Maximum number of tasks allowed in the list. */
  maxTasks?: number;
  /** Path to the shared task list file. If not provided, uses a temp file. */
  filePath?: string;
  /** Lock acquisition timeout in milliseconds. Defaults to 5000ms. */
  lockTimeoutMs?: number;
  /** Lock stale threshold in milliseconds. Defaults to 10000ms. */
  lockStaleMs?: number;
}

interface TaskListData {
  nextId: number;
  tasks: Record<string, TeamTask>;
}

/**
 * A shared task list that enables coordination between team agents.
 * Uses filesystem-based locking for process-safe concurrent access.
 * Each operation acquires a lock, reads the file, mutates, writes, and releases.
 */
export class SharedTaskList {
  private readonly maxTasks: number;
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockStaleMs: number;

  constructor(options: SharedTaskListOptions = {}) {
    this.maxTasks = options.maxTasks ?? 100;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.lockStaleMs = options.lockStaleMs ?? 10000;

    if (options.filePath) {
      this.filePath = options.filePath;
    } else {
      const dir = path.join(os.tmpdir(), `gemini-team-tasks-${Date.now()}`);
      fs.mkdirSync(dir, { recursive: true });
      this.filePath = path.join(dir, 'tasks.json');
    }
    this.lockPath = `${this.filePath}.lock`;

    // Initialize file if it doesn't exist
    if (!fs.existsSync(this.filePath)) {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      this.writeData({ nextId: 1, tasks: {} });
    }
  }

  /**
   * Get the file path for external reference (e.g., passing to teammate agents).
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Add a new task to the shared list.
   */
  addTask(
    title: string,
    description: string,
    createdBy: string,
    dependencies: string[] = [],
  ): TeamTask {
    return this.withLock(() => {
      const data = this.readData();

      if (Object.keys(data.tasks).length >= this.maxTasks) {
        throw new Error(
          `Task list full (max ${this.maxTasks}). Complete or remove tasks first.`,
        );
      }

      const id = `task-${data.nextId++}`;
      const now = Date.now();
      const task: TeamTask = {
        id,
        title,
        description,
        status: 'pending',
        createdBy,
        createdAt: now,
        updatedAt: now,
        dependencies,
      };
      data.tasks[id] = task;
      this.writeData(data);
      return task;
    });
  }

  /**
   * Claim a pending task for a specific agent.
   * Atomic: reads, checks, claims, and writes under a single lock.
   */
  claimTask(taskId: string, assignee: string): TeamTask | undefined {
    return this.withLock(() => {
      const data = this.readData();
      const task = data.tasks[taskId];
      if (!task || task.status !== 'pending') return undefined;

      // Check dependencies are completed
      for (const depId of task.dependencies) {
        const dep = data.tasks[depId];
        if (!dep || dep.status !== 'completed') return undefined;
      }

      task.status = 'in_progress';
      task.assignee = assignee;
      task.updatedAt = Date.now();
      this.writeData(data);
      return task;
    });
  }

  /**
   * Mark a task as completed with a result.
   */
  completeTask(taskId: string, result: string): boolean {
    return this.withLock(() => {
      const data = this.readData();
      const task = data.tasks[taskId];
      if (!task || task.status !== 'in_progress') return false;

      task.status = 'completed';
      task.result = result;
      task.updatedAt = Date.now();
      this.writeData(data);
      return true;
    });
  }

  /**
   * Mark a task as failed with an error.
   */
  failTask(taskId: string, error: string): boolean {
    return this.withLock(() => {
      const data = this.readData();
      const task = data.tasks[taskId];
      if (!task || task.status !== 'in_progress') return false;

      task.status = 'failed';
      task.error = error;
      task.updatedAt = Date.now();
      this.writeData(data);
      return true;
    });
  }

  /**
   * Get all tasks with a specific status.
   */
  getTasksByStatus(status: TaskStatus): TeamTask[] {
    const data = this.readData();
    return Object.values(data.tasks).filter((t) => t.status === status);
  }

  /**
   * Get available tasks (pending with all dependencies met).
   */
  getAvailableTasks(): TeamTask[] {
    const data = this.readData();
    return Object.values(data.tasks).filter((task) => {
      if (task.status !== 'pending') return false;
      return task.dependencies.every((depId) => {
        const dep = data.tasks[depId];
        return dep?.status === 'completed';
      });
    });
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): TeamTask | undefined {
    const data = this.readData();
    return data.tasks[taskId];
  }

  /**
   * Get all tasks.
   */
  getAllTasks(): TeamTask[] {
    const data = this.readData();
    return Object.values(data.tasks);
  }

  /**
   * Get a summary of task statuses.
   */
  getSummary(): Record<TaskStatus, number> {
    const data = this.readData();
    const summary: Record<TaskStatus, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
    };
    for (const task of Object.values(data.tasks)) {
      summary[task.status]++;
    }
    return summary;
  }

  // --- File I/O ---

  private readData(): TaskListData {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (isTaskListData(parsed)) {
        return parsed;
      }
      return { nextId: 1, tasks: {} };
    } catch {
      return { nextId: 1, tasks: {} };
    }
  }

  private writeData(data: TaskListData): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    // Write atomically via temp file + rename
    const tmpPath = `${this.filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, this.filePath);
  }

  // --- Filesystem Locking ---

  /**
   * Acquire a filesystem lock using mkdir (atomic on all OSes).
   * Uses a lockfile directory approach: mkdir is atomic and will fail
   * if the directory already exists.
   */
  private acquireLock(): void {
    const deadline = Date.now() + this.lockTimeoutMs;

    while (Date.now() < deadline) {
      try {
        fs.mkdirSync(this.lockPath);
        // Write PID and timestamp for stale detection
        fs.writeFileSync(
          path.join(this.lockPath, 'info'),
          JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
        );
        return;
      } catch {
        // Lock already held — check if it's stale
        if (this.isLockStale()) {
          this.breakLock();
          continue;
        }
        // Busy-wait with small delay
        const waitMs = 10 + Math.random() * 20;
        const waitUntil = Date.now() + waitMs;
        while (Date.now() < waitUntil) {
          // spin
        }
      }
    }

    throw new Error(
      `Failed to acquire task list lock within ${this.lockTimeoutMs}ms`,
    );
  }

  /**
   * Release the filesystem lock.
   */
  private releaseLock(): void {
    try {
      const infoPath = path.join(this.lockPath, 'info');
      if (fs.existsSync(infoPath)) {
        fs.unlinkSync(infoPath);
      }
      fs.rmdirSync(this.lockPath);
    } catch {
      // Lock may already be released
    }
  }

  /**
   * Check if an existing lock is stale (process died or timeout exceeded).
   */
  private isLockStale(): boolean {
    try {
      const infoPath = path.join(this.lockPath, 'info');
      if (!fs.existsSync(infoPath)) return true;

      const content = fs.readFileSync(infoPath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (!isLockInfo(parsed)) {
        return true;
      }

      // Check if the lock is older than the stale threshold
      if (Date.now() - parsed.timestamp > this.lockStaleMs) {
        return true;
      }

      // Check if the holding process is still alive
      try {
        process.kill(parsed.pid, 0);
        return false; // Process is alive
      } catch {
        return true; // Process is dead
      }
    } catch {
      return true; // Can't read lock info, assume stale
    }
  }

  /**
   * Break a stale lock.
   */
  private breakLock(): void {
    try {
      const infoPath = path.join(this.lockPath, 'info');
      if (fs.existsSync(infoPath)) {
        fs.unlinkSync(infoPath);
      }
      fs.rmdirSync(this.lockPath);
    } catch {
      // Race condition — another process may have broken it
    }
  }

  /**
   * Execute a function while holding the filesystem lock.
   */
  private withLock<T>(fn: () => T): T {
    this.acquireLock();
    try {
      return fn();
    } finally {
      this.releaseLock();
    }
  }
}

function isTaskListData(value: unknown): value is TaskListData {
  if (typeof value !== 'object' || value === null) return false;
  if (!('nextId' in value) || !('tasks' in value)) return false;
  // After `in` checks, TS narrows to `object & Record<'nextId'|'tasks', unknown>`
  return (
    typeof (value as { nextId: unknown }).nextId === 'number' &&
    typeof (value as { tasks: unknown }).tasks === 'object'
  );
}

function isLockInfo(
  value: unknown,
): value is { pid: number; timestamp: number } {
  if (typeof value !== 'object' || value === null) return false;
  if (!('pid' in value) || !('timestamp' in value)) return false;
  return (
    typeof (value as { pid: unknown }).pid === 'number' &&
    typeof (value as { timestamp: unknown }).timestamp === 'number'
  );
}
