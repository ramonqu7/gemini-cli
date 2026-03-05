/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inter-agent messaging via file-based message queues.
 * Each teammate has an inbox directory where other agents can drop messages.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  type: 'request' | 'response' | 'broadcast' | 'status';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface TeammateMessagingOptions {
  /** Base directory for message queues. */
  baseDir: string;
  /** Maximum messages per inbox before oldest are pruned. */
  maxMessagesPerInbox?: number;
}

/**
 * File-based IPC messaging system for agent teams.
 * Each agent has a directory-based inbox. Messages are JSON files.
 */
export class TeammateMessaging {
  private readonly baseDir: string;
  private readonly maxMessages: number;
  private nextMsgId = 1;

  constructor(options: TeammateMessagingOptions) {
    this.baseDir = options.baseDir;
    this.maxMessages = options.maxMessagesPerInbox ?? 50;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  /**
   * Initialize an inbox for an agent.
   */
  initInbox(agentName: string): void {
    const inboxDir = this.getInboxDir(agentName);
    fs.mkdirSync(inboxDir, { recursive: true });
  }

  /**
   * Send a message to a specific agent.
   */
  send(
    from: string,
    to: string,
    type: TeamMessage['type'],
    content: string,
    metadata?: Record<string, unknown>,
  ): TeamMessage {
    const msg: TeamMessage = {
      id: `msg-${this.nextMsgId++}`,
      from,
      to,
      type,
      content,
      timestamp: Date.now(),
      metadata,
    };

    const inboxDir = this.getInboxDir(to);
    fs.mkdirSync(inboxDir, { recursive: true });

    const filePath = path.join(inboxDir, `${msg.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(msg, null, 2));

    this.pruneInbox(to);
    return msg;
  }

  /**
   * Broadcast a message to all agents.
   */
  broadcast(
    from: string,
    agents: string[],
    content: string,
    metadata?: Record<string, unknown>,
  ): TeamMessage[] {
    return agents
      .filter((a) => a !== from)
      .map((to) => this.send(from, to, 'broadcast', content, metadata));
  }

  /**
   * Read all messages in an agent's inbox.
   */
  readInbox(agentName: string): TeamMessage[] {
    const inboxDir = this.getInboxDir(agentName);
    if (!fs.existsSync(inboxDir)) return [];

    const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json'));
    const messages: TeamMessage[] = [];

    for (const file of files) {
      const filePath = path.join(inboxDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (isTeamMessage(parsed)) {
        messages.push(parsed);
      }
    }

    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Clear an agent's inbox.
   */
  clearInbox(agentName: string): void {
    const inboxDir = this.getInboxDir(agentName);
    if (!fs.existsSync(inboxDir)) return;

    const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      fs.unlinkSync(path.join(inboxDir, file));
    }
  }

  /**
   * Clean up all message queues.
   */
  cleanup(): void {
    if (fs.existsSync(this.baseDir)) {
      fs.rmSync(this.baseDir, { recursive: true, force: true });
    }
  }

  private getInboxDir(agentName: string): string {
    return path.join(this.baseDir, agentName);
  }

  private pruneInbox(agentName: string): void {
    const messages = this.readInbox(agentName);
    if (messages.length <= this.maxMessages) return;

    const toRemove = messages.slice(0, messages.length - this.maxMessages);
    const inboxDir = this.getInboxDir(agentName);
    for (const msg of toRemove) {
      const filePath = path.join(inboxDir, `${msg.id}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  }
}

function isTeamMessage(value: unknown): value is TeamMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'from' in value &&
    'to' in value &&
    'type' in value &&
    'content' in value &&
    'timestamp' in value
  );
}
