/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Team manager that orchestrates real agent sessions.
 * Each teammate is a real LocalAgentExecutor with its own context window,
 * connected via the SubagentToolWrapper pattern for spawning.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { SharedTaskList, type TeamTask } from './shared-task-list.js';
import { TeammateMessaging } from './teammate-messaging.js';
import { TmuxDisplay, type TmuxDisplayOptions } from './tmux-display.js';
import { LocalAgentExecutor } from '../local-executor.js';
import {
  AgentTerminateMode,
  type LocalAgentDefinition,
  type OutputObject,
} from '../types.js';
import type { Config } from '../../config/config.js';
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LS_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  READ_MANY_FILES_TOOL_NAME,
} from '../../tools/tool-names.js';
import { z } from 'zod';

export type TeammateRole = 'lead' | 'worker' | 'researcher' | 'reviewer';

/** Tool sets available per role. */
const ROLE_TOOLS: Record<TeammateRole, string[]> = {
  lead: [], // Lead gets all tools (empty = inherit all from parent)
  worker: [
    GLOB_TOOL_NAME,
    GREP_TOOL_NAME,
    LS_TOOL_NAME,
    READ_FILE_TOOL_NAME,
    SHELL_TOOL_NAME,
    WRITE_FILE_TOOL_NAME,
    EDIT_TOOL_NAME,
    READ_MANY_FILES_TOOL_NAME,
  ],
  researcher: [
    GLOB_TOOL_NAME,
    GREP_TOOL_NAME,
    LS_TOOL_NAME,
    READ_FILE_TOOL_NAME,
    READ_MANY_FILES_TOOL_NAME,
  ],
  reviewer: [
    GLOB_TOOL_NAME,
    GREP_TOOL_NAME,
    LS_TOOL_NAME,
    READ_FILE_TOOL_NAME,
    READ_MANY_FILES_TOOL_NAME,
    SHELL_TOOL_NAME,
  ],
};

export interface TeammateInfo {
  name: string;
  role: TeammateRole;
  status: 'idle' | 'working' | 'done' | 'error';
  currentTaskId?: string;
}

/** Internal representation that holds the running agent session. */
interface TeammateSession {
  info: TeammateInfo;
  /** The running agent promise, if actively executing. */
  runPromise?: Promise<OutputObject>;
  /** AbortController for the running agent. */
  abortController?: AbortController;
}

export interface TeamConfig {
  /** Name of the team. Used for tmux session naming and message directories. */
  teamName: string;
  /** Maximum number of teammates (including lead). */
  maxTeammates?: number;
  /** Whether to use terminal display (tmux/iTerm2). */
  enableDisplay?: boolean;
  /** Display options. */
  displayOptions?: TmuxDisplayOptions;
  /** Base directory for IPC. Defaults to a temp dir. */
  ipcDir?: string;
  /** The runtime config needed to create real agent sessions. */
  config: Config;
}

const TeammateOutputSchema = z.object({
  result: z.string().describe('The final result of the teammate task.'),
});

/**
 * Orchestrates a team of real agent sessions working on a shared task list.
 *
 * Architecture:
 * - One lead agent coordinates the overall plan
 * - Worker agents are real LocalAgentExecutor instances with their own context
 * - Each teammate gets tool restrictions based on their role
 * - Communication happens via file-based message queues (peer-to-peer)
 * - Shared task list uses filesystem locking for concurrent access
 * - Optional terminal display shows each agent's activity
 */
export class TeamManager {
  private sessions: Map<string, TeammateSession> = new Map();
  private readonly taskList: SharedTaskList;
  private readonly messaging: TeammateMessaging;
  private readonly display: TmuxDisplay | undefined;
  private readonly maxTeammates: number;
  private readonly runtimeConfig: Config;
  private readonly ipcDir: string;
  private active = false;

  constructor(config: TeamConfig) {
    this.maxTeammates = config.maxTeammates ?? 4;
    this.runtimeConfig = config.config;

    this.ipcDir =
      config.ipcDir ??
      path.join(os.tmpdir(), `gemini-team-${config.teamName}-${Date.now()}`);

    this.taskList = new SharedTaskList({
      filePath: path.join(this.ipcDir, 'tasks', 'tasks.json'),
    });

    this.messaging = new TeammateMessaging({
      baseDir: path.join(this.ipcDir, 'messages'),
    });

    if (config.enableDisplay) {
      this.display = new TmuxDisplay({
        sessionName: `gemini-${config.teamName}`,
        ...config.displayOptions,
      });
    }
  }

  /**
   * Start the team session.
   */
  start(): boolean {
    if (this.active) return false;

    if (this.display) {
      this.display.initialize();
    }

    this.active = true;
    return true;
  }

  /**
   * Add a teammate to the team. Returns the teammate info.
   * This does NOT start the agent yet — call spawnTeammate() to start it.
   */
  addTeammate(
    name: string,
    role: TeammateRole = 'worker',
  ): TeammateInfo | undefined {
    if (!this.active) return undefined;
    if (this.sessions.size >= this.maxTeammates) return undefined;
    if (this.sessions.has(name)) return undefined;

    const info: TeammateInfo = {
      name,
      role,
      status: 'idle',
    };

    this.sessions.set(name, { info });
    this.messaging.initInbox(name);

    if (this.display) {
      this.display.createPane(name);
    }

    return info;
  }

  /**
   * Spawn a real agent session for a teammate with a specific task.
   * Creates a LocalAgentExecutor with role-appropriate tool restrictions,
   * and injects the shared task list and messaging context into the system prompt.
   */
  async spawnTeammate(
    name: string,
    task: string,
    signal?: AbortSignal,
  ): Promise<OutputObject | undefined> {
    const session = this.sessions.get(name);
    if (!session) return undefined;
    if (session.info.status === 'working') return undefined;

    const abortController = new AbortController();
    session.abortController = abortController;

    // Combine external signal if provided
    const combinedSignal = signal
      ? AbortSignal.any([signal, abortController.signal])
      : abortController.signal;

    const definition = this.createTeammateDefinition(name, session.info.role);

    session.info.status = 'working';

    if (this.display) {
      this.display.updatePane(name, `Working on: ${task}`);
    }

    try {
      const executor = await LocalAgentExecutor.create(
        definition,
        this.runtimeConfig,
        (activity) => {
          // Bridge activity events to display
          if (this.display && activity.type === 'THOUGHT_CHUNK') {
            const text = String(activity.data['text'] ?? '');
            if (text.length > 0) {
              this.display.updatePane(name, text.slice(0, 200));
            }
          }
        },
      );

      const result = await executor.run({ task }, combinedSignal);

      session.info.status = 'done';
      if (this.display) {
        this.display.updatePane(name, `Done: ${result.result.slice(0, 100)}`);
      }

      // Notify the lead about completion
      const lead = this.getLead();
      if (lead && lead.name !== name) {
        this.messaging.send(
          name,
          lead.name,
          'status',
          `Completed task: ${result.result}`,
        );
      }

      return result;
    } catch (error) {
      session.info.status = 'error';
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (this.display) {
        this.display.updatePane(name, `Error: ${errorMsg.slice(0, 100)}`);
      }

      return {
        result: `Agent ${name} failed: ${errorMsg}`,
        terminate_reason:
          error instanceof Error && error.name === 'AbortError'
            ? AgentTerminateMode.ABORTED
            : AgentTerminateMode.ERROR,
      };
    }
  }

  /**
   * Spawn multiple teammates concurrently and wait for all to finish.
   */
  async spawnTeammatesConcurrently(
    assignments: Array<{ name: string; task: string }>,
    signal?: AbortSignal,
  ): Promise<Map<string, OutputObject | undefined>> {
    const promises = assignments.map(async ({ name, task }) => {
      const result = await this.spawnTeammate(name, task, signal);
      return [name, result] as const;
    });

    const results = await Promise.all(promises);
    return new Map(results);
  }

  /**
   * Create a LocalAgentDefinition for a teammate with role-appropriate tools.
   */
  private createTeammateDefinition(
    name: string,
    role: TeammateRole,
  ): LocalAgentDefinition<typeof TeammateOutputSchema> {
    const roleTools = ROLE_TOOLS[role];
    const hasToolRestrictions = roleTools.length > 0;

    const teammateSystemPrompt = `You are "${name}", a ${role} agent working as part of a team.

## Team Context
- You are one of several agents collaborating on a project.
- Task file: ${this.taskList.getFilePath()}
- Messages directory: ${this.messaging.getBaseDir()}
- Your inbox: ${path.join(this.messaging.getBaseDir(), name)}

## Team Communication
You can communicate with other teammates by writing JSON message files to their inbox directories.
To send a message to teammate "bob", write a JSON file to: ${this.messaging.getBaseDir()}/bob/
Format: {"from": "${name}", "to": "bob", "type": "peer", "content": "your message", "timestamp": <unix_ms>}

Check your own inbox for messages from other teammates periodically.

## Task Coordination
The shared task list at ${this.taskList.getFilePath()} tracks all tasks.
You can read it to see available tasks and their statuses.

## Your Role: ${role}
${this.getRoleInstructions(role)}

Focus on completing your assigned task efficiently and communicating results back to the team.`;

    return {
      kind: 'local',
      name: `teammate-${name}`,
      displayName: `Teammate: ${name}`,
      description: `Team ${role} agent "${name}"`,
      inputConfig: {
        inputSchema: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: 'The specific task for this teammate to accomplish.',
            },
          },
          required: ['task'],
        },
      },
      outputConfig: {
        outputName: 'result',
        description: 'The result of the teammate task.',
        schema: TeammateOutputSchema,
      },
      modelConfig: {
        model: 'inherit',
      },
      ...(hasToolRestrictions ? { toolConfig: { tools: roleTools } } : {}),
      promptConfig: {
        systemPrompt: teammateSystemPrompt,
        query: '${task}',
      },
      runConfig: {
        maxTimeMinutes: 10,
        maxTurns: 25,
      },
    };
  }

  private getRoleInstructions(role: TeammateRole): string {
    switch (role) {
      case 'lead':
        return 'You coordinate the team. Break down tasks, assign work, and synthesize results.';
      case 'worker':
        return 'You implement changes. Write code, fix bugs, and create files as needed.';
      case 'researcher':
        return 'You investigate the codebase. Read files, search for patterns, and report findings. You have read-only access.';
      case 'reviewer':
        return 'You review code changes. Check for bugs, style issues, and test coverage. You can read files and run commands.';
      default:
        return 'Complete your assigned task.';
    }
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
    const session = this.sessions.get(agentName);
    if (!session || session.info.status === 'working') return undefined;

    const available = this.taskList.getAvailableTasks();
    if (available.length === 0) return undefined;

    const task = this.taskList.claimTask(available[0].id, agentName);
    if (task) {
      session.info.status = 'working';
      session.info.currentTaskId = task.id;

      if (this.display) {
        this.display.updatePane(agentName, `Working on: ${task.title}`);
      }
    }

    return task;
  }

  /**
   * Mark a teammate's current task as completed.
   */
  completeCurrentTask(agentName: string, result: string): boolean {
    const session = this.sessions.get(agentName);
    if (!session?.info.currentTaskId) return false;

    const success = this.taskList.completeTask(
      session.info.currentTaskId,
      result,
    );
    if (success) {
      session.info.status = 'idle';
      session.info.currentTaskId = undefined;

      if (this.display) {
        this.display.updatePane(agentName, 'Idle - waiting for task');
      }

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
   * Send a message between teammates (any-to-any).
   */
  sendMessage(from: string, to: string, content: string): boolean {
    if (!this.sessions.has(from) || !this.sessions.has(to)) return false;
    this.messaging.sendPeer(from, to, content);
    return true;
  }

  /**
   * Broadcast a message to all teammates.
   */
  broadcastMessage(from: string, content: string): void {
    const agentNames = Array.from(this.sessions.keys());
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
  getLead(): TeammateInfo | undefined {
    for (const session of this.sessions.values()) {
      if (session.info.role === 'lead') return session.info;
    }
    return undefined;
  }

  /**
   * Get all teammates.
   */
  getTeammates(): TeammateInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.info);
  }

  /**
   * Get the shared task list.
   */
  getTaskList(): SharedTaskList {
    return this.taskList;
  }

  /**
   * Get the messaging system.
   */
  getMessaging(): TeammateMessaging {
    return this.messaging;
  }

  /**
   * Get a summary of team status.
   */
  getStatus(): {
    active: boolean;
    teammateCount: number;
    taskSummary: Record<string, number>;
    teammates: TeammateInfo[];
  } {
    return {
      active: this.active,
      teammateCount: this.sessions.size,
      taskSummary: this.taskList.getSummary(),
      teammates: this.getTeammates(),
    };
  }

  /**
   * Abort a specific teammate's running agent.
   */
  abortTeammate(name: string): boolean {
    const session = this.sessions.get(name);
    if (!session?.abortController) return false;
    session.abortController.abort();
    session.info.status = 'error';
    return true;
  }

  /**
   * Shut down the entire team.
   */
  shutdown(): void {
    if (!this.active) return;

    // Abort all running agents
    for (const session of this.sessions.values()) {
      if (session.abortController) {
        session.abortController.abort();
      }
    }

    // Notify all teammates
    const lead = this.getLead();
    if (lead) {
      this.broadcastMessage(lead.name, 'Team shutting down');
    }

    // Clean up display
    if (this.display) {
      this.display.shutdown();
    }

    // Clean up messaging
    this.messaging.cleanup();

    this.sessions.clear();
    this.active = false;
  }
}
