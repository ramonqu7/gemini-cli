/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from './config.js';
import type { AgentSession } from './agent-session.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { GeminiClient } from '../core/client.js';
import type { ModelRouterService } from '../routing/modelRouterService.js';
import type { UserHintService } from './userHintService.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

/**
 * Default implementation of AgentSession.
 */
export class DefaultAgentSession implements AgentSession {
  constructor(
    public readonly promptId: string,
    public readonly config: Config,
    public readonly toolRegistry: ToolRegistry,
    public readonly messageBus: MessageBus,
    public readonly geminiClient: GeminiClient,
    public readonly modelRouterService: ModelRouterService,
    public readonly userHintService: UserHintService,
    public readonly parent?: AgentSession,
  ) {}

  /**
   * Creates a child session for a sub-agent.
   *
   * @param agentName The name of the sub-agent.
   * @param subToolRegistry The isolated tool registry for the sub-agent.
   */
  createChildSession(
    agentName: string,
    subToolRegistry: ToolRegistry,
  ): AgentSession {
    const randomIdPart = Math.random().toString(36).slice(2, 8);
    const childPromptId = `${this.promptId}-${agentName}-${randomIdPart}`;

    // Initialize a NEW GeminiClient for full isolation.
    // The new client will inherit history if needed, but for now we keep it fresh.
    const childClient = new GeminiClient(this.config);

    return new DefaultAgentSession(
      childPromptId,
      this.config,
      subToolRegistry,
      this.messageBus,
      childClient,
      this.modelRouterService,
      this.userHintService,
      this,
    );
  }
}
