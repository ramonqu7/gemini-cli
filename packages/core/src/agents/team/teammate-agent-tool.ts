/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TeammateAgent tool definition.
 * Allows the lead agent to create and manage teammates as a tool call,
 * following the SubagentTool pattern from subagent-tool.ts.
 */

import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ToolLiveOutput,
} from '../../tools/tools.js';
import type { MessageBus } from '../../confirmation-bus/message-bus.js';
import {
  TeamManager,
  type TeamConfig,
  type TeammateRole,
} from './team-manager.js';
import type { Config } from '../../config/config.js';

const TEAMMATE_AGENT_TOOL_NAME = 'teammate_agent';

interface TeammateAgentParams {
  action:
    | 'create_team'
    | 'add_teammate'
    | 'spawn_teammate'
    | 'spawn_concurrent'
    | 'get_status'
    | 'send_message'
    | 'broadcast'
    | 'read_messages'
    | 'create_task'
    | 'shutdown';
  team_name?: string;
  teammate_name?: string;
  role?: TeammateRole;
  task?: string;
  message?: string;
  recipient?: string;
  task_title?: string;
  task_description?: string;
  dependencies?: string[];
  assignments?: Array<{ name: string; task: string }>;
}

/** Helper to create a ToolResult with both llmContent and returnDisplay. */
function result(text: string): ToolResult {
  return { llmContent: text, returnDisplay: text };
}

/**
 * A tool that allows the lead agent to manage a team of real agent sessions.
 * Each teammate is a real LocalAgentExecutor instance.
 */
export class TeammateAgentTool extends BaseDeclarativeTool<
  TeammateAgentParams,
  ToolResult
> {
  private teamManager: TeamManager | undefined;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      TEAMMATE_AGENT_TOOL_NAME,
      'Teammate Agent',
      `Manage a team of AI agent teammates. Actions:
- create_team: Initialize a new team (requires team_name)
- add_teammate: Add a teammate (requires teammate_name, optional role: lead|worker|researcher|reviewer)
- spawn_teammate: Start a teammate on a task (requires teammate_name, task)
- spawn_concurrent: Start multiple teammates concurrently (requires assignments: [{name, task}])
- get_status: Get team status
- send_message: Send peer message (requires teammate_name as sender, recipient, message)
- broadcast: Broadcast to all (requires teammate_name as sender, message)
- read_messages: Read inbox (requires teammate_name)
- create_task: Create shared task (requires task_title, task_description, teammate_name as creator)
- shutdown: Shut down the team`,
      Kind.Agent,
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The action to perform.',
            enum: [
              'create_team',
              'add_teammate',
              'spawn_teammate',
              'spawn_concurrent',
              'get_status',
              'send_message',
              'broadcast',
              'read_messages',
              'create_task',
              'shutdown',
            ],
          },
          team_name: {
            type: 'string',
            description: 'Name for the team (for create_team).',
          },
          teammate_name: {
            type: 'string',
            description: 'Name of the teammate.',
          },
          role: {
            type: 'string',
            description: 'Role for the teammate.',
            enum: ['lead', 'worker', 'researcher', 'reviewer'],
          },
          task: {
            type: 'string',
            description: 'Task description for spawn_teammate.',
          },
          message: {
            type: 'string',
            description: 'Message content for send_message/broadcast.',
          },
          recipient: {
            type: 'string',
            description: 'Recipient for send_message.',
          },
          task_title: {
            type: 'string',
            description: 'Title for create_task.',
          },
          task_description: {
            type: 'string',
            description: 'Description for create_task.',
          },
          dependencies: {
            type: 'array',
            items: { type: 'string' },
            description: 'Task IDs this task depends on.',
          },
          assignments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                task: { type: 'string' },
              },
              required: ['name', 'task'],
            },
            description: 'Array of {name, task} for spawn_concurrent.',
          },
        },
        required: ['action'],
      },
      messageBus,
      /* isOutputMarkdown */ true,
      /* canUpdateOutput */ true,
    );
  }

  protected createInvocation(
    params: TeammateAgentParams,
    messageBus: MessageBus,
  ): ToolInvocation<TeammateAgentParams, ToolResult> {
    return new TeammateAgentInvocation(
      params,
      messageBus,
      this.config,
      () => this.teamManager,
      (tm: TeamManager) => {
        this.teamManager = tm;
      },
    );
  }
}

class TeammateAgentInvocation extends BaseToolInvocation<
  TeammateAgentParams,
  ToolResult
> {
  constructor(
    params: TeammateAgentParams,
    messageBus: MessageBus,
    private readonly config: Config,
    private readonly getTeamManager: () => TeamManager | undefined,
    private readonly setTeamManager: (tm: TeamManager) => void,
  ) {
    super(params, messageBus, TEAMMATE_AGENT_TOOL_NAME, 'Teammate Agent');
  }

  getDescription(): string {
    return `Team action: ${this.params.action}`;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
  ): Promise<ToolResult> {
    const { action } = this.params;

    switch (action) {
      case 'create_team':
        return this.handleCreateTeam();
      case 'add_teammate':
        return this.handleAddTeammate();
      case 'spawn_teammate':
        return this.handleSpawnTeammate(signal, updateOutput);
      case 'spawn_concurrent':
        return this.handleSpawnConcurrent(signal, updateOutput);
      case 'get_status':
        return this.handleGetStatus();
      case 'send_message':
        return this.handleSendMessage();
      case 'broadcast':
        return this.handleBroadcast();
      case 'read_messages':
        return this.handleReadMessages();
      case 'create_task':
        return this.handleCreateTask();
      case 'shutdown':
        return this.handleShutdown();
      default:
        return result(`Unknown action: ${action}`);
    }
  }

  private handleCreateTeam(): ToolResult {
    const teamName = this.params.team_name;
    if (!teamName) {
      return result('Error: team_name is required for create_team.');
    }

    const teamConfig: TeamConfig = {
      teamName,
      config: this.config,
      enableDisplay: true,
    };

    const tm = new TeamManager(teamConfig);
    tm.start();
    this.setTeamManager(tm);

    return result(`Team "${teamName}" created and started successfully.`);
  }

  private handleAddTeammate(): ToolResult {
    const tm = this.getTeamManager();
    if (!tm) {
      return result('Error: No team created. Call create_team first.');
    }

    const name = this.params.teammate_name;
    if (!name) {
      return result('Error: teammate_name is required for add_teammate.');
    }

    const role = this.params.role ?? 'worker';
    const info = tm.addTeammate(name, role);

    if (!info) {
      return result(
        `Error: Could not add teammate "${name}". Team may be full or name already taken.`,
      );
    }

    return result(
      `Teammate "${name}" added as ${role}. Ready to spawn with a task.`,
    );
  }

  private async handleSpawnTeammate(
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
  ): Promise<ToolResult> {
    const tm = this.getTeamManager();
    if (!tm) {
      return result('Error: No team created. Call create_team first.');
    }

    const name = this.params.teammate_name;
    const task = this.params.task;
    if (!name || !task) {
      return result(
        'Error: teammate_name and task are required for spawn_teammate.',
      );
    }

    if (updateOutput) {
      updateOutput(
        `Spawning teammate "${name}" on task: ${task.slice(0, 100)}...`,
      );
    }

    const output = await tm.spawnTeammate(name, task, signal);

    if (!output) {
      return result(
        `Error: Could not spawn teammate "${name}". Agent may not exist or is already working.`,
      );
    }

    const text = `Teammate "${name}" finished.\nTermination: ${output.terminate_reason}\nResult:\n${output.result}`;
    return result(text);
  }

  private async handleSpawnConcurrent(
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
  ): Promise<ToolResult> {
    const tm = this.getTeamManager();
    if (!tm) {
      return result('Error: No team created. Call create_team first.');
    }

    const assignments = this.params.assignments;
    if (!assignments || assignments.length === 0) {
      return result(
        'Error: assignments array is required for spawn_concurrent.',
      );
    }

    if (updateOutput) {
      const names = assignments.map((a) => a.name).join(', ');
      updateOutput(
        `Spawning ${assignments.length} teammates concurrently: ${names}`,
      );
    }

    const results = await tm.spawnTeammatesConcurrently(assignments, signal);

    const summary = Array.from(results.entries())
      .map(([name, output]) => {
        if (!output) return `${name}: Failed to spawn`;
        return `${name} (${output.terminate_reason}): ${output.result.slice(0, 200)}`;
      })
      .join('\n\n');

    return result(`Concurrent execution complete.\n\n${summary}`);
  }

  private handleGetStatus(): ToolResult {
    const tm = this.getTeamManager();
    if (!tm) {
      return result('Error: No team created. Call create_team first.');
    }

    const status = tm.getStatus();
    return result(JSON.stringify(status, null, 2));
  }

  private handleSendMessage(): ToolResult {
    const tm = this.getTeamManager();
    if (!tm) {
      return result('Error: No team created.');
    }

    const from = this.params.teammate_name;
    const to = this.params.recipient;
    const message = this.params.message;

    if (!from || !to || !message) {
      return result(
        'Error: teammate_name, recipient, and message are required for send_message.',
      );
    }

    const sent = tm.sendMessage(from, to, message);
    return result(
      sent
        ? `Message sent from "${from}" to "${to}".`
        : `Error: Could not send message. Check that both agents exist.`,
    );
  }

  private handleBroadcast(): ToolResult {
    const tm = this.getTeamManager();
    if (!tm) {
      return result('Error: No team created.');
    }

    const from = this.params.teammate_name;
    const message = this.params.message;

    if (!from || !message) {
      return result(
        'Error: teammate_name and message are required for broadcast.',
      );
    }

    tm.broadcastMessage(from, message);
    return result(`Broadcast sent from "${from}" to all teammates.`);
  }

  private handleReadMessages(): ToolResult {
    const tm = this.getTeamManager();
    if (!tm) {
      return result('Error: No team created.');
    }

    const name = this.params.teammate_name;
    if (!name) {
      return result('Error: teammate_name is required for read_messages.');
    }

    const messages = tm.readMessages(name);
    if (messages.length === 0) {
      return result(`No messages in "${name}"'s inbox.`);
    }

    const formatted = messages
      .map((m) => `[${m.type}] ${m.from} -> ${m.to}: ${m.content}`)
      .join('\n');

    return result(formatted);
  }

  private handleCreateTask(): ToolResult {
    const tm = this.getTeamManager();
    if (!tm) {
      return result('Error: No team created.');
    }

    const title = this.params.task_title;
    const description = this.params.task_description;
    const createdBy = this.params.teammate_name;

    if (!title || !description || !createdBy) {
      return result(
        'Error: task_title, task_description, and teammate_name are required.',
      );
    }

    const task = tm.createTask(
      title,
      description,
      createdBy,
      this.params.dependencies,
    );

    return result(`Task created: ${task.id} - "${task.title}"`);
  }

  private handleShutdown(): ToolResult {
    const tm = this.getTeamManager();
    if (!tm) {
      return result('No team to shut down.');
    }

    tm.shutdown();
    return result('Team shut down successfully.');
  }
}

export { TEAMMATE_AGENT_TOOL_NAME };
