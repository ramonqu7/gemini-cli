/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * tmux pane management for agent team display.
 * Creates and manages tmux panes to show each teammate's activity.
 */

import {
  execSync,
  type ExecSyncOptionsWithStringEncoding,
} from 'node:child_process';

export interface TmuxPane {
  paneId: string;
  agentName: string;
  index: number;
}

export interface TmuxDisplayOptions {
  /** tmux session name. */
  sessionName?: string;
  /** Layout style for panes. */
  layout?: 'tiled' | 'even-horizontal' | 'even-vertical';
}

/**
 * Manages tmux panes for displaying agent team activity.
 */
export class TmuxDisplay {
  private readonly sessionName: string;
  private readonly layout: string;
  private panes: TmuxPane[] = [];
  private initialized = false;

  constructor(options: TmuxDisplayOptions = {}) {
    this.sessionName = options.sessionName ?? 'gemini-team';
    this.layout = options.layout ?? 'tiled';
  }

  /**
   * Check if tmux is available on the system.
   */
  static isAvailable(): boolean {
    try {
      execSync('which tmux', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if we're currently inside a tmux session.
   */
  static isInsideTmux(): boolean {
    return !!process.env['TMUX'];
  }

  /**
   * Initialize the tmux session for the team.
   */
  initialize(): boolean {
    if (!TmuxDisplay.isAvailable()) return false;

    try {
      // Create a new session (detached if not inside tmux)
      if (!TmuxDisplay.isInsideTmux()) {
        this.exec(`tmux new-session -d -s ${this.sessionName} -x 200 -y 50`);
      }
      this.initialized = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a new pane for a teammate.
   */
  createPane(agentName: string): TmuxPane | undefined {
    if (!this.initialized) return undefined;

    try {
      const target = TmuxDisplay.isInsideTmux() ? '' : `-t ${this.sessionName}`;

      // Split the window to create a new pane
      this.exec(`tmux split-window ${target} -h`);

      // Get the new pane ID
      const paneId = this.exec(`tmux display-message -p '#{pane_id}'`).trim();

      // Set the pane title
      this.exec(`tmux select-pane -t ${paneId} -T '${agentName}'`);

      // Rebalance the layout
      this.exec(`tmux select-layout ${target} ${this.layout}`);

      const pane: TmuxPane = {
        paneId,
        agentName,
        index: this.panes.length,
      };
      this.panes.push(pane);
      return pane;
    } catch {
      return undefined;
    }
  }

  /**
   * Send text/status update to a specific pane.
   */
  updatePane(agentName: string, text: string): boolean {
    const pane = this.panes.find((p) => p.agentName === agentName);
    if (!pane) return false;

    try {
      // Clear and write new content
      this.exec(`tmux send-keys -t ${pane.paneId} 'clear' Enter`);
      // Escape single quotes in the text
      const escaped = text.replace(/'/g, "'\\''");
      this.exec(`tmux send-keys -t ${pane.paneId} 'echo "${escaped}"' Enter`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all active panes.
   */
  getPanes(): TmuxPane[] {
    return [...this.panes];
  }

  /**
   * Close a specific pane.
   */
  closePane(agentName: string): boolean {
    const paneIndex = this.panes.findIndex((p) => p.agentName === agentName);
    if (paneIndex === -1) return false;

    const pane = this.panes[paneIndex];
    try {
      this.exec(`tmux kill-pane -t ${pane.paneId}`);
      this.panes.splice(paneIndex, 1);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Shut down all panes and the session.
   */
  shutdown(): void {
    if (!this.initialized) return;

    try {
      if (!TmuxDisplay.isInsideTmux()) {
        this.exec(`tmux kill-session -t ${this.sessionName}`);
      } else {
        // Close all agent panes but keep the main session
        for (const pane of [...this.panes].reverse()) {
          try {
            this.exec(`tmux kill-pane -t ${pane.paneId}`);
          } catch {
            // Pane may already be closed
          }
        }
      }
    } catch {
      // Session may already be closed
    }

    this.panes = [];
    this.initialized = false;
  }

  private exec(command: string): string {
    const options: ExecSyncOptionsWithStringEncoding = {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    return execSync(command, options);
  }
}
