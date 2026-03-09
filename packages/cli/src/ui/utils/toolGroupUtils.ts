/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IndividualToolCallDisplay } from '../types.js';
import { ToolCallStatus, mapCoreStatusToDisplayStatus } from '../types.js';

interface ToolGroupCounts {
  running: number;
  completed: number;
  errored: number;
  total: number;
}

/**
 * Counts tool calls by their execution status.
 */
export function getToolGroupCounts(
  toolCalls: IndividualToolCallDisplay[],
): ToolGroupCounts {
  let running = 0;
  let completed = 0;
  let errored = 0;

  for (const tool of toolCalls) {
    const status = mapCoreStatusToDisplayStatus(tool.status);
    switch (status) {
      case ToolCallStatus.Executing:
        running++;
        break;
      case ToolCallStatus.Success:
        completed++;
        break;
      case ToolCallStatus.Error:
        errored++;
        break;
      case ToolCallStatus.Canceled:
        errored++;
        break;
      default:
        break;
    }
  }

  return { running, completed, errored, total: toolCalls.length };
}

type ToolCategory = 'read' | 'write' | 'shell' | 'search' | 'other';

const CATEGORY_LABELS: Record<ToolCategory, (count: number) => string> = {
  read: (n) => `read ${n} file${n !== 1 ? 's' : ''}`,
  write: (n) => `modified ${n} file${n !== 1 ? 's' : ''}`,
  shell: (n) => `ran ${n} command${n !== 1 ? 's' : ''}`,
  search: (n) => `searched ${n} pattern${n !== 1 ? 's' : ''}`,
  other: (n) => `${n} other tool${n !== 1 ? 's' : ''}`,
};

function categorizeToolName(name: string): ToolCategory {
  const lower = name.toLowerCase();

  // File reads
  if (
    lower === 'readfile' ||
    lower === 'batchreadfiles' ||
    lower === 'read_file' ||
    lower === 'read_many_files' ||
    lower === 'batch_read_files' ||
    lower.includes('read')
  ) {
    return 'read';
  }

  // File writes/edits
  if (
    lower === 'writefile' ||
    lower === 'edit' ||
    lower === 'write_file' ||
    lower === 'replace' ||
    lower.includes('write') ||
    lower.includes('edit') ||
    lower.includes('create')
  ) {
    return 'write';
  }

  // Shell commands
  if (
    lower === 'shell command' ||
    lower === 'shell' ||
    lower === 'batchshellcommands' ||
    lower === 'run_shell_command' ||
    lower === 'batch_shell_commands'
  ) {
    return 'shell';
  }

  // Search tools
  if (
    lower === 'findfiles' ||
    lower === 'grep' ||
    lower === 'grep_search' ||
    lower === 'glob' ||
    lower === 'list_directory' ||
    lower.includes('search') ||
    lower.includes('grep') ||
    lower.includes('glob') ||
    lower.includes('find')
  ) {
    return 'search';
  }

  return 'other';
}

/**
 * Generates a human-readable summary of what a tool group did.
 * e.g. "Read 3 files, modified 1 file, ran 2 commands"
 */
export function summarizeToolGroupActivity(
  toolCalls: IndividualToolCallDisplay[],
): string {
  const categoryCounts: Record<ToolCategory, number> = {
    read: 0,
    write: 0,
    shell: 0,
    search: 0,
    other: 0,
  };

  for (const tool of toolCalls) {
    const category = categorizeToolName(tool.name);
    categoryCounts[category]++;
  }

  // Build the summary in a natural reading order
  const order: ToolCategory[] = ['search', 'read', 'write', 'shell', 'other'];
  const parts: string[] = [];
  for (const cat of order) {
    const count = categoryCounts[cat];
    if (count > 0) {
      parts.push(CATEGORY_LABELS[cat](count));
    }
  }

  if (parts.length === 0) {
    return '';
  }

  // Capitalize first letter
  const summary = parts.join(', ');
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}
