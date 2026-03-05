/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { exec } from 'node:child_process';
import { debugLogger } from '../utils/debugLogger.js';

/**
 * Sends an OS-level desktop notification.
 *
 * Platform support:
 * - Linux: uses `notify-send`
 * - macOS: uses `osascript`
 *
 * The call is fire-and-forget: errors are logged but never propagated,
 * so it will never delay a response.
 *
 * @param title Notification title.
 * @param body  Notification body text.
 */
export function notify(title: string, body: string): void {
  const sanitizedTitle = title.replace(/["`$\\]/g, '');
  const sanitizedBody = body.replace(/["`$\\]/g, '');

  let cmd: string;

  switch (process.platform) {
    case 'linux':
      cmd = `notify-send "${sanitizedTitle}" "${sanitizedBody}"`;
      break;
    case 'darwin':
      cmd = `osascript -e 'display notification "${sanitizedBody}" with title "${sanitizedTitle}"'`;
      break;
    default:
      // Unsupported platform — silently skip.
      return;
  }

  exec(cmd, (err) => {
    if (err) {
      debugLogger.debug(
        `Desktop notification failed (platform=${process.platform}):`,
        err,
      );
    }
  });
}

/**
 * Sends a formatted "task complete" desktop notification.
 *
 * @param description Short description of the completed task.
 * @param durationMs  How long the task took, in milliseconds.
 */
export function notifyTaskComplete(
  description: string,
  durationMs: number,
): void {
  const seconds = Math.round(durationMs / 1000);
  const durationStr =
    seconds >= 60
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${seconds}s`;

  notify('Gemini CLI — Task Complete', `${description} (${durationStr})`);
}
