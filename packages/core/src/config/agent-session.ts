/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from './config.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { GeminiClient } from '../core/client.js';
import type { ModelRouterService } from '../routing/modelRouterService.js';
import type { UserHintService } from './userHintService.js';

/**
 * Represents the execution context for a single agent loop or turn.
 * This object carries the stateful services and identifiers required
 * for an agent to operate, isolating it from other concurrent executions.
 */
export interface AgentSession {
  /** The unique ID for this execution (turn or agent loop). */
  readonly promptId: string;

  /** The global configuration (settings, environment, etc.). */
  readonly config: Config;

  /** The tools available to this agent in this session. */
  readonly toolRegistry: ToolRegistry;

  /** The message bus for tool confirmations. */
  readonly messageBus: MessageBus;

  /** The stateful Gemini client (handles history for this session). */
  readonly geminiClient: GeminiClient;

  /** The router used to select models for this session. */
  readonly modelRouterService: ModelRouterService;

  /** The user hint service for this session. */
  readonly userHintService: UserHintService;

  /** Parent session if this is a sub-agent execution. */
  readonly parent?: AgentSession;

  /**
   * Creates a child session for a sub-agent.
   *
   * @param agentName The name of the sub-agent.
   * @param subToolRegistry The isolated tool registry for the sub-agent.
   */
  createChildSession(
    agentName: string,
    subToolRegistry: ToolRegistry,
  ): AgentSession;
}
