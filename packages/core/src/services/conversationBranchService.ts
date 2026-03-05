/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';

/**
 * A lightweight snapshot of the conversation state at a specific user turn.
 * Stores only a preview of the message, not the full content, to keep
 * memory usage reasonable.
 */
export interface Waypoint {
  /** Sequential turn index (0-based, incremented per user message). */
  turnIndex: number;
  /** ISO timestamp when the waypoint was created. */
  timestamp: string;
  /** First 80 characters of the user message for display purposes. */
  messagePreview: string;
  /** Snapshot of the client history at this point (before the user message was sent). */
  historySnapshot: Content[];
  /** Whether this waypoint was previously rewound from (creating a branch). */
  isBranchPoint: boolean;
}

const MAX_PREVIEW_LENGTH = 80;

/**
 * Manages conversation waypoints for selective rewind and branching.
 *
 * Each user turn creates a waypoint that captures the conversation state
 * *before* that turn was processed. This allows rewinding to any previous
 * point in the conversation without affecting file state (which is handled
 * separately by the checkpoint/restore system).
 *
 * The service is intentionally independent of the git-based checkpoint
 * infrastructure — it only tracks conversation (Content[]) state.
 */
export class ConversationBranchService {
  private waypoints: Waypoint[] = [];
  private currentTurnIndex = 0;

  /**
   * Creates a waypoint capturing the current conversation state.
   * Should be called at the start of each user turn, before the message
   * is added to history.
   *
   * @param userMessage The user's message text (will be truncated to 80 chars for preview).
   * @param currentHistory The current client history Content[] array. A shallow copy is stored.
   */
  addWaypoint(userMessage: string, currentHistory: Content[]): Waypoint {
    const preview =
      userMessage.length > MAX_PREVIEW_LENGTH
        ? userMessage.slice(0, MAX_PREVIEW_LENGTH) + '...'
        : userMessage;

    const waypoint: Waypoint = {
      turnIndex: this.currentTurnIndex,
      timestamp: new Date().toISOString(),
      messagePreview: preview,
      // Store a shallow copy of the history array. Each Content object is
      // treated as immutable by the Gemini SDK, so shallow copy is sufficient.
      historySnapshot: [...currentHistory],
      isBranchPoint: false,
    };

    // If we've rewound and are now adding a new waypoint, trim any
    // waypoints that were after the current position (they belong to
    // the old branch).
    if (this.waypoints.length > 0) {
      const lastWaypoint = this.waypoints[this.waypoints.length - 1];
      if (
        lastWaypoint &&
        lastWaypoint.turnIndex >= this.currentTurnIndex
      ) {
        // We've rewound — trim future waypoints from the old timeline
        this.waypoints = this.waypoints.filter(
          (wp) => wp.turnIndex < this.currentTurnIndex,
        );
      }
    }

    this.waypoints.push(waypoint);
    this.currentTurnIndex++;
    return waypoint;
  }

  /**
   * Returns all waypoints in chronological order.
   */
  getWaypoints(): readonly Waypoint[] {
    return this.waypoints;
  }

  /**
   * Returns the total number of user turns recorded.
   */
  getTurnCount(): number {
    return this.currentTurnIndex;
  }

  /**
   * Rewinds to a specific turn index. Returns the history snapshot at that
   * point, or null if the turn index is invalid.
   *
   * The waypoint is marked as a branch point for future reference.
   *
   * @param turnIndex The turn index to rewind to (0-based).
   * @returns The history Content[] at that waypoint, or null if not found.
   */
  rewindToTurn(turnIndex: number): Content[] | null {
    const waypoint = this.waypoints.find((wp) => wp.turnIndex === turnIndex);
    if (!waypoint) {
      return null;
    }

    waypoint.isBranchPoint = true;
    // Reset the turn counter so the next addWaypoint starts from this point
    this.currentTurnIndex = waypoint.turnIndex;

    return [...waypoint.historySnapshot];
  }

  /**
   * Rewinds by N turns from the current position. Returns the history
   * snapshot at that point, or null if N exceeds available history.
   *
   * @param n Number of turns to go back.
   * @returns The history Content[] at that waypoint, or null if not found.
   */
  rewindByN(n: number): { history: Content[]; waypoint: Waypoint } | null {
    const targetTurnIndex = this.currentTurnIndex - n;
    if (targetTurnIndex < 0) {
      return null;
    }

    const waypoint = this.waypoints.find(
      (wp) => wp.turnIndex === targetTurnIndex,
    );
    if (!waypoint) {
      return null;
    }

    waypoint.isBranchPoint = true;
    this.currentTurnIndex = waypoint.turnIndex;

    return {
      history: [...waypoint.historySnapshot],
      waypoint,
    };
  }

  /**
   * Returns waypoints that have been rewound from (branch points).
   * Useful for showing the user where the conversation timeline diverged.
   */
  getBranchPoints(): readonly Waypoint[] {
    return this.waypoints.filter((wp) => wp.isBranchPoint);
  }

  /**
   * Returns a formatted string listing recent waypoints for display.
   *
   * @param maxItems Maximum number of items to show (default: 20).
   */
  formatWaypointList(maxItems: number = 20): string {
    if (this.waypoints.length === 0) {
      return 'No conversation waypoints recorded yet.';
    }

    const waypointsToShow = this.waypoints.slice(-maxItems);
    const lines: string[] = [];

    for (const wp of waypointsToShow) {
      const branchMarker = wp.isBranchPoint ? ' [branch]' : '';
      const currentMarker =
        wp.turnIndex === this.currentTurnIndex - 1 ? ' <-- current' : '';
      const time = new Date(wp.timestamp).toLocaleTimeString();
      lines.push(
        `  Turn ${wp.turnIndex}: [${time}] "${wp.messagePreview}"${branchMarker}${currentMarker}`,
      );
    }

    if (this.waypoints.length > maxItems) {
      lines.unshift(
        `  ... (${this.waypoints.length - maxItems} earlier turns omitted)`,
      );
    }

    return lines.join('\n');
  }

  /**
   * Resets all waypoints and the turn counter. Used when conversation
   * is cleared or a new session starts.
   */
  reset(): void {
    this.waypoints = [];
    this.currentTurnIndex = 0;
  }
}
