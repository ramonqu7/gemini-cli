/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inter-agent messaging via file-based message queues.
 * Supports direct messages, broadcasts, and peer-to-peer communication
 * between any teammates (not just lead-to-worker).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type MessageType =
  | 'request'
  | 'response'
  | 'broadcast'
  | 'status'
  | 'peer';

export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  type: MessageType;
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
 * Any agent can send messages to any other agent (peer-to-peer).
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
   * Get the base directory for external reference.
   */
  getBaseDir(): string {
    return this.baseDir;
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
    type: MessageType,
    content: string,
    metadata?: Record<string, unknown>,
  ): TeamMessage {
    const msg: TeamMessage = {
      id: `msg-${this.nextMsgId++}-${Date.now()}`,
      from,
      to,
      type,
      content,
      timestamp: Date.now(),
      metadata,
    };

    const inboxDir = this.getInboxDir(to);
    fs.mkdirSync(inboxDir, { recursive: true });

    // Write atomically via temp + rename
    const filePath = path.join(inboxDir, `${msg.id}.json`);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(msg, null, 2));
    fs.renameSync(tmpPath, filePath);

    this.pruneInbox(to);
    return msg;
  }

  /**
   * Send a peer-to-peer message between any two agents.
   */
  sendPeer(
    from: string,
    to: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): TeamMessage {
    return this.send(from, to, 'peer', content, metadata);
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
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed: unknown = JSON.parse(content);
        if (isTeamMessage(parsed)) {
          messages.push(parsed);
        }
      } catch {
        // Skip corrupted messages
      }
    }

    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Read and consume messages (read then clear).
   */
  consumeInbox(agentName: string): TeamMessage[] {
    const messages = this.readInbox(agentName);
    this.clearInbox(agentName);
    return messages;
  }

  /**
   * Read messages from a specific sender.
   */
  readMessagesFrom(agentName: string, from: string): TeamMessage[] {
    return this.readInbox(agentName).filter((m) => m.from === from);
  }

  /**
   * Clear an agent's inbox.
   */
  clearInbox(agentName: string): void {
    const inboxDir = this.getInboxDir(agentName);
    if (!fs.existsSync(inboxDir)) return;

    const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(inboxDir, file));
      } catch {
        // File may already be deleted
      }
    }
  }

  /**
   * Get all registered agent names (based on inbox directories).
   */
  getRegisteredAgents(): string[] {
    if (!fs.existsSync(this.baseDir)) return [];
    return fs
      .readdirSync(this.baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
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
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // File may already be deleted
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
