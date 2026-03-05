/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal pane management for agent team display.
 * Supports both tmux and iTerm2 split panes for showing each teammate's activity.
 */

import {
  execSync,
  type ExecSyncOptionsWithStringEncoding,
} from 'node:child_process';

export type TerminalBackend = 'tmux' | 'iterm2' | 'none';

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
  /** Force a specific backend. If not set, auto-detects. */
  backend?: TerminalBackend;
}

/**
 * Manages terminal panes for displaying agent team activity.
 * Auto-detects iTerm2 vs tmux and uses the appropriate backend.
 */
export class TmuxDisplay {
  private readonly sessionName: string;
  private readonly layout: string;
  private panes: TmuxPane[] = [];
  private initialized = false;
  private backend: TerminalBackend = 'none';

  constructor(options: TmuxDisplayOptions = {}) {
    this.sessionName = options.sessionName ?? 'gemini-team';
    this.layout = options.layout ?? 'tiled';

    if (options.backend) {
      this.backend = options.backend;
    } else {
      this.backend = TmuxDisplay.detectBackend();
    }
  }

  /**
   * Auto-detect the best terminal backend.
   * Priority: iTerm2 > tmux-inside > tmux-available > none
   */
  static detectBackend(): TerminalBackend {
    if (TmuxDisplay.isITerm2()) return 'iterm2';
    if (TmuxDisplay.isInsideTmux()) return 'tmux';
    if (TmuxDisplay.isTmuxAvailable()) return 'tmux';
    return 'none';
  }

  /**
   * Check if we're running inside iTerm2.
   * Checks multiple environment variables for robust detection.
   */
  static isITerm2(): boolean {
    return (
      process.env['TERM_PROGRAM'] === 'iTerm.app' ||
      process.env['LC_TERMINAL'] === 'iTerm2' ||
      !!process.env['ITERM_SESSION_ID']
    );
  }

  /**
   * Check if tmux is available on the system.
   */
  static isTmuxAvailable(): boolean {
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
   * Get the detected backend.
   */
  getBackend(): TerminalBackend {
    return this.backend;
  }

  /**
   * Initialize the display session for the team.
   */
  initialize(): boolean {
    if (this.backend === 'none') return false;

    try {
      if (this.backend === 'iterm2') {
        // iTerm2 doesn't need explicit session creation
        this.initialized = true;
        return true;
      }

      // tmux backend
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
      if (this.backend === 'iterm2') {
        return this.createITerm2Pane(agentName);
      }
      return this.createTmuxPane(agentName);
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
      if (this.backend === 'iterm2') {
        return this.updateITerm2Pane(pane, text);
      }
      return this.updateTmuxPane(pane, text);
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
      if (this.backend === 'iterm2') {
        this.execAppleScript(
          `tell application "iTerm2" to tell current window to tell session id "${pane.paneId}" to close`,
        );
      } else {
        this.exec(`tmux kill-pane -t ${pane.paneId}`);
      }
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
      if (this.backend === 'iterm2') {
        for (const pane of [...this.panes].reverse()) {
          try {
            this.execAppleScript(
              `tell application "iTerm2" to tell current window to tell session id "${pane.paneId}" to close`,
            );
          } catch {
            // Pane may already be closed
          }
        }
      } else if (this.backend === 'tmux') {
        if (!TmuxDisplay.isInsideTmux()) {
          this.exec(`tmux kill-session -t ${this.sessionName}`);
        } else {
          for (const pane of [...this.panes].reverse()) {
            try {
              this.exec(`tmux kill-pane -t ${pane.paneId}`);
            } catch {
              // Pane may already be closed
            }
          }
        }
      }
    } catch {
      // Session may already be closed
    }

    this.panes = [];
    this.initialized = false;
  }

  // --- tmux-specific methods ---

  private createTmuxPane(agentName: string): TmuxPane | undefined {
    const target = TmuxDisplay.isInsideTmux() ? '' : `-t ${this.sessionName}`;

    this.exec(`tmux split-window ${target} -h`);
    const paneId = this.exec(`tmux display-message -p '#{pane_id}'`).trim();
    this.exec(`tmux select-pane -t ${paneId} -T '${agentName}'`);
    this.exec(`tmux select-layout ${target} ${this.layout}`);

    const pane: TmuxPane = {
      paneId,
      agentName,
      index: this.panes.length,
    };
    this.panes.push(pane);
    return pane;
  }

  private updateTmuxPane(pane: TmuxPane, text: string): boolean {
    this.exec(`tmux send-keys -t ${pane.paneId} 'clear' Enter`);
    const escaped = text.replace(/'/g, "'\\''");
    this.exec(`tmux send-keys -t ${pane.paneId} 'echo "${escaped}"' Enter`);
    return true;
  }

  // --- iTerm2-specific methods ---

  private createITerm2Pane(agentName: string): TmuxPane | undefined {
    const escapedName = agentName.replace(/"/g, '\\"');
    const result = this.execAppleScript(
      [
        'tell application "iTerm2"',
        '  tell current window',
        '    tell current session',
        `      set newSession to (split vertically with default profile)`,
        '      tell newSession',
        `        set name to "${escapedName}"`,
        `        write text "echo '=== Agent: ${escapedName} ==='"`,
        '      end tell',
        '      return id of newSession',
        '    end tell',
        '  end tell',
        'end tell',
      ].join('\n'),
    ).trim();

    const pane: TmuxPane = {
      paneId: result,
      agentName,
      index: this.panes.length,
    };
    this.panes.push(pane);
    return pane;
  }

  private updateITerm2Pane(pane: TmuxPane, text: string): boolean {
    const escaped = text.replace(/"/g, '\\"').replace(/'/g, "'");
    this.execAppleScript(
      [
        'tell application "iTerm2"',
        '  tell current window',
        `    tell session id "${pane.paneId}"`,
        `      write text "clear && echo '${escaped}'"`,
        '    end tell',
        '  end tell',
        'end tell',
      ].join('\n'),
    );
    return true;
  }

  // --- Execution helpers ---

  private exec(command: string): string {
    const options: ExecSyncOptionsWithStringEncoding = {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    return execSync(command, options);
  }

  private execAppleScript(script: string): string {
    // Use -e flag with each line to avoid shell escaping issues
    const lines = script
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const args = lines.map((l) => `-e '${l.replace(/'/g, "'\\''")}'`).join(' ');
    return this.exec(`osascript ${args}`);
  }
}
