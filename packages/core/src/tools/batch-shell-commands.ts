/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type ToolCallConfirmationDetails,
  type ToolExecuteConfirmationDetails,
  ToolConfirmationOutcome,
  type PolicyUpdateOptions,
} from './tools.js';
import type { Config } from '../config/config.js';
import {
  BATCH_SHELL_COMMANDS_TOOL_NAME,
  BATCH_SHELL_COMMANDS_DISPLAY_NAME,
} from './tool-names.js';
import { BATCH_SHELL_COMMANDS_DEFINITION } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';
import { ShellToolInvocation } from './shell.js';
import {
  getCommandRoots,
  stripShellWrapper,
} from '../utils/shell-utils.js';

/**
 * A single command entry in the batch
 */
interface CommandEntry {
  command: string;
  description?: string;
}

/**
 * Parameters for the BatchShellCommands tool
 */
export interface BatchShellCommandsToolParams {
  commands: CommandEntry[];
}

class BatchShellCommandsToolInvocation extends BaseToolInvocation<
  BatchShellCommandsToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: BatchShellCommandsToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    const cmdList = this.params.commands
      .map((c, i) => `${i + 1}. ${c.command}`)
      .join('; ');
    return `Batch: ${cmdList}`;
  }

  protected override getPolicyUpdateOptions(
    outcome: ToolConfirmationOutcome,
  ): PolicyUpdateOptions | undefined {
    if (
      outcome === ToolConfirmationOutcome.ProceedAlwaysAndSave ||
      outcome === ToolConfirmationOutcome.ProceedAlways
    ) {
      const allRoots: string[] = [];
      for (const entry of this.params.commands) {
        const stripped = stripShellWrapper(entry.command);
        const roots = getCommandRoots(stripped);
        allRoots.push(...roots);
      }
      const uniqueRoots = [...new Set(allRoots)];
      if (uniqueRoots.length > 0) {
        return { commandPrefix: uniqueRoots };
      }
    }
    return undefined;
  }

  protected override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    const allRoots: string[] = [];
    const allCommands: string[] = [];
    for (const entry of this.params.commands) {
      const stripped = stripShellWrapper(entry.command);
      const roots = getCommandRoots(stripped);
      allRoots.push(...roots);
      allCommands.push(entry.command);
    }
    const uniqueRoots = [...new Set(allRoots)];

    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Batch Shell Commands',
      command: allCommands.join(' && '),
      rootCommand: uniqueRoots.join(', '),
      rootCommands: uniqueRoots,
      commands: allCommands,
      onConfirm: async (_outcome: ToolConfirmationOutcome) => {
        // Policy updates are handled centrally by the scheduler
      },
    };
    return confirmationDetails;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    // Execute all commands in parallel using ShellToolInvocation
    const results = await Promise.allSettled(
      this.params.commands.map((entry) =>
        this.executeSingleCommand(entry, signal),
      ),
    );

    const parts: string[] = [];
    let hasErrors = false;

    for (let i = 0; i < results.length; i++) {
      const entry = this.params.commands[i];
      const result = results[i];
      const label = entry.description
        ? `${entry.description} (${entry.command})`
        : entry.command;

      if (result.status === 'fulfilled') {
        const toolResult = result.value;
        parts.push(`=== Command ${i + 1}: ${label} ===\n${typeof toolResult.llmContent === 'string' ? toolResult.llmContent : ''}`);
        if (toolResult.error) {
          hasErrors = true;
        }
      } else {
        hasErrors = true;
        const errorMsg = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        parts.push(`=== Command ${i + 1}: ${label} === ERROR: ${errorMsg}`);
      }
    }

    const llmContent = parts.join('\n\n');
    const successCount = results.filter(
      (r) => r.status === 'fulfilled' && !r.value.error,
    ).length;
    const errorCount = this.params.commands.length - successCount;

    let returnDisplay = `Executed ${successCount} command(s)`;
    if (errorCount > 0) {
      returnDisplay += `, ${errorCount} failed`;
    }

    return {
      llmContent,
      returnDisplay,
      ...(hasErrors
        ? {
            error: {
              message: `${errorCount} command(s) failed`,
              type: undefined,
            },
          }
        : {}),
    };
  }

  private async executeSingleCommand(
    entry: CommandEntry,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const invocation = new ShellToolInvocation(
      this.config,
      {
        command: entry.command,
        description: entry.description,
      },
      this.messageBus,
      this._toolName,
      this._toolDisplayName,
    );
    return invocation.execute(signal);
  }
}

/**
 * Implementation of the BatchShellCommands tool
 */
export class BatchShellCommandsTool extends BaseDeclarativeTool<
  BatchShellCommandsToolParams,
  ToolResult
> {
  static readonly Name = BATCH_SHELL_COMMANDS_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      BatchShellCommandsTool.Name,
      BATCH_SHELL_COMMANDS_DISPLAY_NAME,
      BATCH_SHELL_COMMANDS_DEFINITION.base.description!,
      Kind.Execute,
      BATCH_SHELL_COMMANDS_DEFINITION.base.parametersJsonSchema,
      messageBus,
      false,
      false,
    );
  }

  protected override validateToolParamValues(
    params: BatchShellCommandsToolParams,
  ): string | null {
    if (!params.commands || !Array.isArray(params.commands)) {
      return "The 'commands' parameter must be an array.";
    }

    if (params.commands.length === 0) {
      return "The 'commands' array must not be empty.";
    }

    if (params.commands.length > 5) {
      return 'Maximum of 5 commands allowed per batch execution.';
    }

    for (let i = 0; i < params.commands.length; i++) {
      const entry = params.commands[i];
      if (!entry.command || typeof entry.command !== 'string') {
        return `Command at index ${i} must have a non-empty 'command' string.`;
      }
      if (!entry.command.trim()) {
        return `Command at index ${i} cannot be empty.`;
      }
    }

    return null;
  }

  protected createInvocation(
    params: BatchShellCommandsToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<BatchShellCommandsToolParams, ToolResult> {
    return new BatchShellCommandsToolInvocation(
      this.config,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }

  override getSchema(modelId?: string) {
    return resolveToolDeclaration(BATCH_SHELL_COMMANDS_DEFINITION, modelId);
  }
}
