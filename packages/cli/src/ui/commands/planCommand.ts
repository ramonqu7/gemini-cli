/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
} from './types.js';
import {
  ApprovalMode,
  coreEvents,
  debugLogger,
  processSingleFileContent,
  partToString,
  readFileWithEncoding,
} from '@google/gemini-cli-core';
import { MessageType } from '../types.js';
import * as path from 'node:path';
import { copyToClipboard } from '../utils/commandUtils.js';

async function copyAction(context: CommandContext) {
  const config = context.services.config;
  if (!config) {
    debugLogger.debug('Plan copy command: config is not available in context');
    return;
  }

  const planPath = config.getApprovedPlanPath();

  if (!planPath) {
    coreEvents.emitFeedback('warning', 'No approved plan found to copy.');
    return;
  }

  try {
    const content = await readFileWithEncoding(planPath);
    await copyToClipboard(content);
    coreEvents.emitFeedback(
      'info',
      `Plan copied to clipboard (${path.basename(planPath)}).`,
    );
  } catch (error) {
    coreEvents.emitFeedback('error', `Failed to copy plan: ${error}`, error);
  }
}

/**
 * /plan auto - Approve the plan and execute steps autonomously with
 * checkpoints and test verification between each step.
 */
async function autoAction(context: CommandContext) {
  const config = context.services.config;
  if (!config) {
    debugLogger.debug(
      'Plan auto command: config is not available in context',
    );
    return;
  }

  const planExec = config.getPlanExecutionService();
  const state = planExec.getState();

  if (!state) {
    coreEvents.emitFeedback(
      'warning',
      'No plan to execute. The model must first create a numbered plan.',
    );
    return;
  }

  if (state.status !== 'planning') {
    coreEvents.emitFeedback(
      'warning',
      `Plan is already in "${state.status}" status. Cannot approve again.`,
    );
    return;
  }

  const approved = planExec.approvePlan();
  if (!approved) {
    coreEvents.emitFeedback('error', 'Failed to approve plan (no steps).');
    return;
  }

  // Enable autonomous execution mode
  planExec.setAutonomous(true);

  // Clear context for fresh execution
  const geminiClient = config.getGeminiClient();
  if (geminiClient) {
    coreEvents.emitFeedback(
      'info',
      `Plan approved for autonomous execution (max ${planExec.getMaxAutonomousSteps()} steps before pause).`,
    );
    await geminiClient.resetChat();
    context.ui.clear();
  }

  // Switch to auto_edit mode for execution
  config.setApprovalMode(ApprovalMode.AUTO_EDIT);

  // Refresh system prompt — autonomous step prompt will be injected
  geminiClient?.updateSystemInstruction();

  coreEvents.emitFeedback(
    'info',
    'Autonomous execution started. The model will checkpoint and test after each step.',
  );
  context.ui.addItem({
    type: MessageType.GEMINI,
    text: planExec.formatPlan(),
  });
}

/**
 * /plan approve - Approve the current plan and begin step-by-step execution.
 */
async function approveAction(context: CommandContext) {
  const config = context.services.config;
  if (!config) {
    debugLogger.debug(
      'Plan approve command: config is not available in context',
    );
    return;
  }

  const planExec = config.getPlanExecutionService();
  const state = planExec.getState();

  if (!state) {
    coreEvents.emitFeedback(
      'warning',
      'No plan to approve. The model must first create a numbered plan.',
    );
    return;
  }

  if (state.status !== 'planning') {
    coreEvents.emitFeedback(
      'warning',
      `Plan is already in "${state.status}" status. Cannot approve again.`,
    );
    return;
  }

  const approved = planExec.approvePlan();
  if (!approved) {
    coreEvents.emitFeedback('error', 'Failed to approve plan (no steps).');
    return;
  }

  // Clear context for fresh execution — the planning phase consumed tokens
  // on exploration and discussion. Execution starts fresh with only the plan
  // injected into the system prompt.
  const geminiClient = config.getGeminiClient();
  if (geminiClient) {
    coreEvents.emitFeedback(
      'info',
      'Plan approved. Clearing context for fresh execution...',
    );
    await geminiClient.resetChat();
    context.ui.clear();
  }

  // Switch out of plan mode into auto_edit for execution
  config.setApprovalMode(ApprovalMode.AUTO_EDIT);

  // Refresh system prompt — the plan step prompt will be injected
  // via promptProvider since planExec.isExecuting() is now true
  geminiClient?.updateSystemInstruction();

  coreEvents.emitFeedback(
    'info',
    'Context cleared. Executing plan step-by-step in Auto-Edit mode.',
  );
  context.ui.addItem({
    type: MessageType.GEMINI,
    text: planExec.formatPlan(),
  });

  // Step prompt is injected into system instruction. User types "go" to start.
}

/**
 * /plan skip - Skip the current step and move to the next.
 */
async function skipAction(context: CommandContext) {
  const config = context.services.config;
  if (!config) {
    debugLogger.debug('Plan skip command: config is not available in context');
    return;
  }

  const planExec = config.getPlanExecutionService();

  if (!planExec.isExecuting()) {
    coreEvents.emitFeedback(
      'warning',
      'No plan is currently executing. Nothing to skip.',
    );
    return;
  }

  const nextStep = planExec.skipCurrentStep();
  if (nextStep) {
    planExec.startCurrentStep();
    // Refresh system prompt for new step
    config.getGeminiClient()?.updateSystemInstruction();
    coreEvents.emitFeedback(
      'info',
      `Step skipped. Now on step ${nextStep.index}: ${nextStep.description}`,
    );
  } else {
    coreEvents.emitFeedback('info', 'Step skipped. Plan is now complete.');
  }

  context.ui.addItem({
    type: MessageType.GEMINI,
    text: planExec.formatPlan(),
  });
}

/**
 * /plan next - Approve the result of the current step and advance to the next.
 */
async function nextAction(context: CommandContext) {
  const config = context.services.config;
  if (!config) {
    debugLogger.debug('Plan next command: config is not available in context');
    return;
  }

  const planExec = config.getPlanExecutionService();

  if (!planExec.isExecuting()) {
    coreEvents.emitFeedback(
      'warning',
      'No plan is currently executing. Nothing to advance.',
    );
    return;
  }

  const nextStep = planExec.advanceStep();
  if (nextStep) {
    planExec.startCurrentStep();
    // Refresh system prompt for the new step
    config.getGeminiClient()?.updateSystemInstruction();
    coreEvents.emitFeedback(
      'info',
      `Step completed. Now executing step ${nextStep.index}: ${nextStep.description}`,
    );
  } else {
    coreEvents.emitFeedback('info', 'All steps completed. Plan execution finished.');
  }

  context.ui.addItem({
    type: MessageType.GEMINI,
    text: planExec.formatPlan(),
  });
}

/**
 * /plan status - Show the current plan status without changing anything.
 */
async function statusAction(context: CommandContext) {
  const config = context.services.config;
  if (!config) {
    debugLogger.debug(
      'Plan status command: config is not available in context',
    );
    return;
  }

  const planExec = config.getPlanExecutionService();
  const state = planExec.getState();

  if (!state) {
    coreEvents.emitFeedback('info', 'No active plan.');
    return;
  }

  context.ui.addItem({
    type: MessageType.GEMINI,
    text: planExec.formatPlan(),
  });
}

/**
 * /plan modify N "new description" - Modify a pending step's description.
 */
async function modifyAction(context: CommandContext, args: string) {
  const config = context.services.config;
  if (!config) {
    debugLogger.debug(
      'Plan modify command: config is not available in context',
    );
    return;
  }

  const planExec = config.getPlanExecutionService();

  if (!planExec.getState()) {
    coreEvents.emitFeedback('warning', 'No active plan to modify.');
    return;
  }

  // Parse: N "new description" or N new description
  const modifyMatch = args.match(/^\s*(\d+)\s+["']?(.+?)["']?\s*$/);
  if (!modifyMatch) {
    coreEvents.emitFeedback(
      'warning',
      'Usage: /plan modify <step_number> <new description>',
    );
    return;
  }

  const stepNumber = parseInt(modifyMatch[1], 10);
  const newDescription = modifyMatch[2];

  const success = planExec.modifyStep(stepNumber, newDescription);
  if (success) {
    // Refresh system prompt to reflect the modified step
    config.getGeminiClient()?.updateSystemInstruction();
    coreEvents.emitFeedback(
      'info',
      `Step ${stepNumber} modified to: "${newDescription}"`,
    );
    context.ui.addItem({
      type: MessageType.GEMINI,
      text: planExec.formatPlan(),
    });
  } else {
    coreEvents.emitFeedback(
      'warning',
      `Cannot modify step ${stepNumber}. It may not exist or is not in pending status.`,
    );
  }
}

/**
 * /plan reset - Reset the plan execution service, clearing all state.
 */
async function resetAction(context: CommandContext) {
  const config = context.services.config;
  if (!config) {
    debugLogger.debug('Plan reset command: config is not available in context');
    return;
  }

  const planExec = config.getPlanExecutionService();
  planExec.reset();

  // Refresh system prompt
  config.getGeminiClient()?.updateSystemInstruction();

  coreEvents.emitFeedback('info', 'Plan execution state has been reset.');
}

export const planCommand: SlashCommand = {
  name: 'plan',
  description: 'Switch to Plan Mode and view current plan',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context) => {
    const config = context.services.config;
    if (!config) {
      debugLogger.debug('Plan command: config is not available in context');
      return;
    }

    const previousApprovalMode = config.getApprovalMode();
    config.setApprovalMode(ApprovalMode.PLAN);

    if (previousApprovalMode !== ApprovalMode.PLAN) {
      coreEvents.emitFeedback('info', 'Switched to Plan Mode.');
    }

    // If there's an active execution plan, show its status
    const planExec = config.getPlanExecutionService();
    const executionState = planExec.getState();
    if (executionState) {
      context.ui.addItem({
        type: MessageType.GEMINI,
        text: planExec.formatPlan(),
      });
      return;
    }

    const approvedPlanPath = config.getApprovedPlanPath();

    if (!approvedPlanPath) {
      return;
    }

    try {
      const content = await processSingleFileContent(
        approvedPlanPath,
        config.storage.getPlansDir(),
        config.getFileSystemService(),
      );
      const fileName = path.basename(approvedPlanPath);

      coreEvents.emitFeedback('info', `Approved Plan: ${fileName}`);

      context.ui.addItem({
        type: MessageType.GEMINI,
        text: partToString(content.llmContent),
      });
    } catch (error) {
      coreEvents.emitFeedback(
        'error',
        `Failed to read approved plan at ${approvedPlanPath}: ${error}`,
        error,
      );
    }
  },
  subCommands: [
    {
      name: 'copy',
      description: 'Copy the currently approved plan to your clipboard',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: copyAction,
    },
    {
      name: 'approve',
      description: 'Approve the current plan and begin step-by-step execution',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: approveAction,
    },
    {
      name: 'auto',
      description:
        'Approve the plan and execute autonomously with checkpoints and test verification',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: autoAction,
    },
    {
      name: 'next',
      description:
        'Approve the current step result and advance to the next step',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: nextAction,
    },
    {
      name: 'skip',
      description: 'Skip the current step and move to the next',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: skipAction,
    },
    {
      name: 'status',
      description: 'Show the current plan execution status',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: statusAction,
    },
    {
      name: 'modify',
      description:
        'Modify a pending step: /plan modify <step_number> <new description>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: (context, args) => modifyAction(context, args),
    },
    {
      name: 'reset',
      description: 'Reset all plan execution state',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: resetAction,
    },
  ],
};
