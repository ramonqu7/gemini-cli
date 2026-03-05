/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  TeamManager,
  type TeamConfig,
  type TeammateInfo,
  type TeammateRole,
} from './team-manager.js';
export {
  SharedTaskList,
  type TeamTask,
  type TaskStatus,
  type SharedTaskListOptions,
} from './shared-task-list.js';
export {
  TeammateMessaging,
  type TeamMessage,
  type MessageType,
  type TeammateMessagingOptions,
} from './teammate-messaging.js';
export {
  TmuxDisplay,
  type TmuxPane,
  type TmuxDisplayOptions,
  type TerminalBackend,
} from './tmux-display.js';
export {
  TeammateAgentTool,
  TEAMMATE_AGENT_TOOL_NAME,
} from './teammate-agent-tool.js';
