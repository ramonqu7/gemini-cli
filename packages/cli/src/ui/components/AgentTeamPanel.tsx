/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { CliSpinner } from './CliSpinner.js';
import { TOOL_STATUS } from '../constants.js';
import { useUIState } from '../contexts/UIStateContext.js';
import {
  isSubagentProgress,
  type SubagentProgress,
} from '@google/gemini-cli-core';
import type {
  HistoryItemWithoutId,
  HistoryItem,
  IndividualToolCallDisplay,
} from '../types.js';
import { useElapsedTime } from '../hooks/useElapsedTime.js';

/**
 * Formats a token count into a compact human-readable string.
 * e.g., 500 -> "500", 1200 -> "1.2K", 45000 -> "45K", 1200000 -> "1.2M"
 */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    const m = count / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const k = count / 1_000;
    return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`;
  }
  return String(count);
}

/**
 * Extracts active SubagentProgress entries from history and pending items.
 */
function extractSubagentProgress(
  history: HistoryItem[],
  pending: HistoryItemWithoutId[],
): SubagentProgress[] {
  const results: SubagentProgress[] = [];
  const seen = new Set<string>();

  const scanTools = (tools: IndividualToolCallDisplay[]) => {
    for (const tool of tools) {
      if (
        tool.resultDisplay &&
        isSubagentProgress(tool.resultDisplay) &&
        !seen.has(tool.resultDisplay.agentName)
      ) {
        seen.add(tool.resultDisplay.agentName);
        results.push(tool.resultDisplay);
      }
    }
  };

  // Scan pending items first (most recent state)
  for (const item of pending) {
    if (item.type === 'tool_group') {
      scanTools(item.tools);
    }
  }

  // Then scan recent history (last 5 items) for subagents that may have just completed
  const recentHistory = history.slice(-5);
  for (const item of recentHistory) {
    if (item.type === 'tool_group') {
      scanTools(item.tools);
    }
  }

  return results;
}

interface AgentRowProps {
  progress: SubagentProgress;
}

const AgentRow: React.FC<AgentRowProps> = ({ progress }) => {
  const isRunning =
    progress.state === 'running' || progress.state === undefined;
  const elapsed = useElapsedTime(isRunning);

  // Get the latest activity for a one-line summary
  const latestActivity =
    progress.recentActivity[progress.recentActivity.length - 1];
  let activityText = '';
  if (latestActivity) {
    if (latestActivity.type === 'tool_call') {
      const name = latestActivity.displayName || latestActivity.content;
      const desc = latestActivity.description || '';
      activityText = desc ? `${name} ${desc}` : name;
    } else {
      activityText = latestActivity.content;
    }
    // Truncate to fit
    if (activityText.length > 50) {
      activityText = activityText.slice(0, 50) + '…';
    }
  }

  let statusIcon: React.ReactNode;
  let statusColor: string;
  switch (progress.state) {
    case 'completed':
      statusIcon = (
        <Text color={theme.status.success}>{TOOL_STATUS.SUCCESS}</Text>
      );
      statusColor = theme.status.success;
      break;
    case 'error':
      statusIcon = <Text color={theme.status.error}>{TOOL_STATUS.ERROR}</Text>;
      statusColor = theme.status.error;
      break;
    case 'cancelled':
      statusIcon = (
        <Text color={theme.status.warning} bold>
          {TOOL_STATUS.CANCELED}
        </Text>
      );
      statusColor = theme.status.warning;
      break;
    default:
      statusIcon = (
        <Text color={theme.ui.active}>
          <CliSpinner type="toggle" />
        </Text>
      );
      statusColor = theme.ui.active;
      break;
  }

  return (
    <Box flexDirection="row" height={1} overflow="hidden">
      <Box minWidth={3}>{statusIcon}</Box>
      <Box minWidth={1}>
        <Text color={statusColor} bold wrap="truncate">
          {progress.agentName}
        </Text>
      </Box>
      {activityText && (
        <Box marginLeft={1} flexGrow={1} flexShrink={1}>
          <Text color={theme.text.secondary} wrap="truncate" dimColor>
            {activityText}
          </Text>
        </Box>
      )}
      {progress.tokenCount != null && progress.tokenCount > 0 && (
        <Box marginLeft={1} flexShrink={0}>
          <Text color={theme.text.secondary} dimColor>
            {formatTokenCount(progress.tokenCount)} tokens
          </Text>
        </Box>
      )}
      {elapsed && (
        <Box marginLeft={1} flexShrink={0}>
          <Text color={theme.text.secondary} dimColor>
            ({elapsed})
          </Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * Displays a compact panel showing all active/recent subagents.
 * Only renders when 2+ subagents are detected (i.e., a team is running).
 */
export const AgentTeamPanel: React.FC = () => {
  const { history, pendingHistoryItems, terminalWidth } = useUIState();

  const subagents = useMemo(
    () => extractSubagentProgress(history, pendingHistoryItems),
    [history, pendingHistoryItems],
  );

  // Only show the panel when there are multiple subagents (a team)
  if (subagents.length < 2) {
    return null;
  }

  const running = subagents.filter(
    (s) => s.state === 'running' || s.state === undefined,
  ).length;
  const completed = subagents.filter((s) => s.state === 'completed').length;
  const total = subagents.length;

  return (
    <Box
      flexDirection="column"
      width={terminalWidth}
      borderStyle="round"
      borderColor={theme.border.default}
      borderDimColor
      paddingX={1}
      marginBottom={1}
    >
      <Box
        height={1}
        overflow="hidden"
        marginBottom={subagents.length > 0 ? 0 : undefined}
      >
        <Text color={theme.text.accent} bold wrap="truncate">
          Agent Team
        </Text>
        <Box marginLeft={1}>
          <Text color={theme.text.secondary} dimColor wrap="truncate">
            {running > 0 && `${running} active`}
            {running > 0 && completed > 0 && ', '}
            {completed > 0 && `${completed}/${total} done`}
            {running === 0 && completed === 0 && `${total} agents`}
          </Text>
        </Box>
      </Box>
      {subagents.map((progress) => (
        <AgentRow key={progress.agentName} progress={progress} />
      ))}
    </Box>
  );
};
