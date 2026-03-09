/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import {
  ELAPSED_TIME_SHOW_THRESHOLD_MS,
  ELAPSED_TIME_UPDATE_INTERVAL_MS,
} from '../constants.js';

/**
 * Formats elapsed seconds into a compact display string.
 * Under 60s: "3s", 60s+: "1m 5s"
 */
export function formatElapsedTime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

/**
 * Tracks elapsed time for an active operation.
 * Only returns a display string after the threshold (default 2s) to
 * avoid flicker for fast tools.
 *
 * @param isActive Whether the timer should be running (e.g., tool is executing).
 * @returns The formatted elapsed time string, or null if below threshold.
 */
export const useElapsedTime = (isActive: boolean): string | null => {
  const [elapsedMs, setElapsedMs] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (isActive) {
      startTimeRef.current = Date.now();
      setElapsedMs(0);

      intervalRef.current = setInterval(() => {
        if (startTimeRef.current !== null) {
          setElapsedMs(Date.now() - startTimeRef.current);
        }
      }, ELAPSED_TIME_UPDATE_INTERVAL_MS);
    } else {
      startTimeRef.current = null;
      setElapsedMs(0);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isActive]);

  if (!isActive || elapsedMs < ELAPSED_TIME_SHOW_THRESHOLD_MS) {
    return null;
  }

  return formatElapsedTime(Math.floor(elapsedMs / 1000));
};
