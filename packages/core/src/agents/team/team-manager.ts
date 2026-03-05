/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Team manager that orchestrates agent team creation, lifecycle, and shutdown.
 * The lead agent coordinates work while teammates execute tasks independently.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { SharedTaskList, type TeamTask } from './shared-task-list.js';
import { TeammateMessaging } from './teammate-messaging.js';
import { TmuxDisplay, type TmuxDisplayOptions } from './tmux-display.js';

export type TeammateRole = 'lead' | 'worker';

export interface Teammate {
  name: string;
  role: TeammateRole;
  status: 'idle' | 'working' | 'done' | 'error';
  currentTaskId?: string;
}

export interface TeamConfig {
  /** Name of the team. Used for tmux session naming and message directories. */
  teamName: string;
  /** Maximum number of teammates (including lead). */
  maxTeammates?: number;
  /** Whether to use tmux for display. */
  enableTmux?: boolean;
  /** tmux display options. */
  tmuxOptions?: TmuxDisplayOptions;
  /** Base directory for IPC message files. Defaults to a temp dir. */
  messageDir?: string;
}

/**
 * Orchestrates a team of agents working together on a shared task list.
 *
 * Architecture:
 * - One lead agent coordinates the overall plan
 * - Worker agents claim and execute individual tasks
 * - Communication happens via file-based message queues
 * - Optional tmux display shows each agent's activity
 */
export class TeamManager {
  private teammates: Map<string, Teammate> = new Map();
  private readonly taskList: SharedTaskList;
  private readonly messaging: TeammateMessaging;
  private readonly tmuxDisplay: TmuxDisplay | undefined;
  private readonly maxTeammates: number;
  private active = false;

  constructor(config: TeamConfig) {
    this.maxTeammates = config.maxTeammates ?? 4;

    this.taskList = new SharedTaskList();

    const messageDir =
      config.messageDir ??
      path.join(os.tmpdir(), `gemini-team-${config.teamName}-${Date.now()}`);
    this.messaging = new TeammateMessaging({ baseDir: messageDir });

    if (config.enableTmux) {
      this.tmuxDisplay = new TmuxDisplay({
        sessionName: `gemini-${config.teamName}`,
        ...config.tmuxOptions,
      });
    }
  }

  /**
   * Start the team session.
   */
  start(): boolean {
    if (this.active) return false;

    if (this.tmuxDisplay) {
      this.tmuxDisplay.initialize();
    }

    this.active = true;
    return true;
  }

  /**
   * Add a teammate to the team.
   */
  addTeammate(
    name: string,
    role: TeammateRole = 'worker',
  ): Teammate | undefined {
    if (!this.active) return undefined;
    if (this.teammates.size >= this.maxTeammates) return undefined;
    if (this.teammates.has(name)) return undefined;

    const teammate: Teammate = {
      name,
      role,
      status: 'idle',
    };

    this.teammates.set(name, teammate);
    this.messaging.initInbox(name);

    if (this.tmuxDisplay) {
      this.tmuxDisplay.createPane(name);
    }

    return teammate;
  }

  /**
   * Create a task and add it to the shared task list.
   */
  createTask(
    title: string,
    description: string,
    createdBy: string,
    dependencies: string[] = [],
  ): TeamTask {
    return this.taskList.addTask(title, description, createdBy, dependencies);
  }

  /**
   * Have a teammate claim an available task.
   */
  claimNextTask(agentName: string): TeamTask | undefined {
    const teammate = this.teammates.get(agentName);
    if (!teammate || teammate.status === 'working') return undefined;

    const available = this.taskList.getAvailableTasks();
    if (available.length === 0) return undefined;

    const task = this.taskList.claimTask(available[0].id, agentName);
    if (task) {
      teammate.status = 'working';
      teammate.currentTaskId = task.id;

      if (this.tmuxDisplay) {
        this.tmuxDisplay.updatePane(agentName, `Working on: ${task.title}`);
      }
    }

    return task;
  }

  /**
   * Mark a teammate's current task as completed.
   */
  completeCurrentTask(agentName: string, result: string): boolean {
    const teammate = this.teammates.get(agentName);
    if (!teammate?.currentTaskId) return false;

    const success = this.taskList.completeTask(teammate.currentTaskId, result);
    if (success) {
      teammate.status = 'idle';
      teammate.currentTaskId = undefined;

      if (this.tmuxDisplay) {
        this.tmuxDisplay.updatePane(agentName, 'Idle - waiting for task');
      }

      // Notify the lead
      const lead = this.getLead();
      if (lead && lead.name !== agentName) {
        this.messaging.send(
          agentName,
          lead.name,
          'status',
          `Completed task: ${result}`,
        );
      }
    }

    return success;
  }

  /**
   * Send a message between teammates.
   */
  sendMessage(from: string, to: string, content: string): boolean {
    if (!this.teammates.has(from) || !this.teammates.has(to)) return false;
    this.messaging.send(from, to, 'request', content);
    return true;
  }

  /**
   * Broadcast a message to all teammates.
   */
  broadcastMessage(from: string, content: string): void {
    const agentNames = Array.from(this.teammates.keys());
    this.messaging.broadcast(from, agentNames, content);
  }

  /**
   * Read messages for a specific teammate.
   */
  readMessages(agentName: string) {
    return this.messaging.readInbox(agentName);
  }

  /**
   * Get the lead agent.
   */
  getLead(): Teammate | undefined {
    for (const teammate of this.teammates.values()) {
      if (teammate.role === 'lead') return teammate;
    }
    return undefined;
  }

  /**
   * Get all teammates.
   */
  getTeammates(): Teammate[] {
    return Array.from(this.teammates.values());
  }

  /**
   * Get the shared task list.
   */
  getTaskList(): SharedTaskList {
    return this.taskList;
  }

  /**
   * Get a summary of team status.
   */
  getStatus(): {
    active: boolean;
    teammateCount: number;
    taskSummary: Record<string, number>;
    teammates: Teammate[];
  } {
    return {
      active: this.active,
      teammateCount: this.teammates.size,
      taskSummary: this.taskList.getSummary(),
      teammates: this.getTeammates(),
    };
  }

  /**
   * Shut down the entire team.
   */
  shutdown(): void {
    if (!this.active) return;

    // Notify all teammates
    const lead = this.getLead();
    if (lead) {
      this.broadcastMessage(lead.name, 'Team shutting down');
    }

    // Clean up tmux
    if (this.tmuxDisplay) {
      this.tmuxDisplay.shutdown();
    }

    // Clean up messaging
    this.messaging.cleanup();

    this.teammates.clear();
    this.active = false;
  }
}
