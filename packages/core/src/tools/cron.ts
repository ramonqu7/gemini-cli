/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import type { CronService } from '../services/cronService.js';
import { parseCronExpression } from '../services/cronService.js';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import { CRON_TOOL_NAME, CRON_DISPLAY_NAME } from './tool-names.js';
import { CRON_DEFINITION } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';

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
 * Parameters for the CronTool
 */
export interface CronToolParams {
  action: 'create' | 'list' | 'delete';
  cron_expression?: string;
  prompt?: string;
  recurring?: boolean;
  persistent?: boolean;
  task_id?: string;
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

class CronToolInvocation extends BaseToolInvocation<CronToolParams, ToolResult> {
  constructor(
    private readonly config: Config,
    params: CronToolParams,
    messageBus: MessageBus,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, messageBus, toolName, displayName);
  }

  getDescription(): string {
    return `Cron ${this.params.action}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const cronService = this.config.getCronService();
    if (!cronService) {
      return {
        llmContent: 'Cron service is not available.',
        returnDisplay: 'Cron service is not available.',
        error: {
          message: 'Cron service is not available.',
          type: undefined,
        },
      };
    }

    switch (this.params.action) {
      case 'create': {
        const result = handleCronCreate(cronService, {
          cron_expression: this.params.cron_expression!,
          prompt: this.params.prompt!,
          recurring: this.params.recurring,
          persistent: this.params.persistent,
        });
        const llmContent = JSON.stringify(result);
        const display = result.success
          ? `Created task ${result.taskId} (${result.schedule})`
          : `Error: ${result.error}`;
        return {
          llmContent,
          returnDisplay: display,
          ...(result.success
            ? {}
            : { error: { message: result.error!, type: undefined } }),
        };
      }
      case 'list': {
        const listing = handleCronList(cronService);
        return {
          llmContent: listing,
          returnDisplay: listing,
        };
      }
      case 'delete': {
        const result = handleCronDelete(cronService, {
          task_id: this.params.task_id!,
        });
        const llmContent = JSON.stringify(result);
        const display = result.success
          ? `Deleted task ${this.params.task_id}`
          : `Error: ${result.error}`;
        return {
          llmContent,
          returnDisplay: display,
          ...(result.success
            ? {}
            : { error: { message: result.error!, type: undefined } }),
        };
      }
    }
  }
}

/**
 * Implementation of the CronManage tool.
 */
export class CronTool extends BaseDeclarativeTool<CronToolParams, ToolResult> {
  static readonly Name = CRON_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      CronTool.Name,
      CRON_DISPLAY_NAME,
      CRON_DEFINITION.base.description!,
      Kind.Execute,
      CRON_DEFINITION.base.parametersJsonSchema,
      messageBus,
      false,
      false,
    );
  }

  protected override validateToolParamValues(
    params: CronToolParams,
  ): string | null {
    switch (params.action) {
      case 'create':
        if (!params.cron_expression) {
          return 'Parameter "cron_expression" is required for action "create".';
        }
        if (!params.prompt) {
          return 'Parameter "prompt" is required for action "create".';
        }
        return null;
      case 'delete':
        if (!params.task_id) {
          return 'Parameter "task_id" is required for action "delete".';
        }
        return null;
      case 'list':
        return null;
      default:
        return `Unknown action: "${params.action}". Must be "create", "list", or "delete".`;
    }
  }

  protected createInvocation(
    params: CronToolParams,
    messageBus: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<CronToolParams, ToolResult> {
    return new CronToolInvocation(
      this.config,
      params,
      messageBus,
      toolName ?? this.name,
      displayName ?? this.displayName,
    );
  }

  override getSchema(modelId?: string) {
    return resolveToolDeclaration(CRON_DEFINITION, modelId);
  }
}
