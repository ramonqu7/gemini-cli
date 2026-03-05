/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared task list for agent team coordination.
 * Provides a thread-safe task queue that teammates can read from and write to.
 */

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
}

/**
 * A shared task list that enables coordination between team agents.
 * Each teammate can create, claim, update, and complete tasks.
 */
export class SharedTaskList {
  private tasks: Map<string, TeamTask> = new Map();
  private nextId = 1;
  private readonly maxTasks: number;

  constructor(options: SharedTaskListOptions = {}) {
    this.maxTasks = options.maxTasks ?? 100;
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
    if (this.tasks.size >= this.maxTasks) {
      throw new Error(
        `Task list full (max ${this.maxTasks}). Complete or remove tasks first.`,
      );
    }

    const id = `task-${this.nextId++}`;
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
    this.tasks.set(id, task);
    return task;
  }

  /**
   * Claim a pending task for a specific agent.
   */
  claimTask(taskId: string, assignee: string): TeamTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'pending') return undefined;

    // Check dependencies are completed
    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep || dep.status !== 'completed') return undefined;
    }

    task.status = 'in_progress';
    task.assignee = assignee;
    task.updatedAt = Date.now();
    return task;
  }

  /**
   * Mark a task as completed with a result.
   */
  completeTask(taskId: string, result: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'in_progress') return false;

    task.status = 'completed';
    task.result = result;
    task.updatedAt = Date.now();
    return true;
  }

  /**
   * Mark a task as failed with an error.
   */
  failTask(taskId: string, error: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'in_progress') return false;

    task.status = 'failed';
    task.error = error;
    task.updatedAt = Date.now();
    return true;
  }

  /**
   * Get all tasks with a specific status.
   */
  getTasksByStatus(status: TaskStatus): TeamTask[] {
    return Array.from(this.tasks.values()).filter((t) => t.status === status);
  }

  /**
   * Get available tasks (pending with all dependencies met).
   */
  getAvailableTasks(): TeamTask[] {
    return Array.from(this.tasks.values()).filter((task) => {
      if (task.status !== 'pending') return false;
      return task.dependencies.every((depId) => {
        const dep = this.tasks.get(depId);
        return dep?.status === 'completed';
      });
    });
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): TeamTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks.
   */
  getAllTasks(): TeamTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get a summary of task statuses.
   */
  getSummary(): Record<TaskStatus, number> {
    const summary: Record<TaskStatus, number> = {
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
    };
    for (const task of this.tasks.values()) {
      summary[task.status]++;
    }
    return summary;
  }
}
