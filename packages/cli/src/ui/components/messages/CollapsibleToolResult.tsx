/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import {
  ToolResultDisplay,
  type ToolResultDisplayProps,
} from './ToolResultDisplay.js';
import { useSettings } from '../../contexts/SettingsContext.js';
import { CoreToolCallStatus } from '@google/gemini-cli-core';
import { theme } from '../../semantic-colors.js';

export interface CollapsibleToolResultProps extends ToolResultDisplayProps {
  /** Tool call status — errors are always shown expanded. */
  status: CoreToolCallStatus;
}

/**
 * Counts the lines in a tool result for the summary display.
 */
function countResultLines(
  resultDisplay: ToolResultDisplayProps['resultDisplay'],
): number | null {
  if (typeof resultDisplay === 'string') {
    const trimmed = resultDisplay.endsWith('\n')
      ? resultDisplay.slice(0, -1)
      : resultDisplay;
    return trimmed.split('\n').length;
  }
  if (Array.isArray(resultDisplay)) {
    return resultDisplay.length;
  }
  return null;
}

/**
 * Builds a compact summary of the tool output.
 */
function formatSummary(
  resultDisplay: ToolResultDisplayProps['resultDisplay'],
): string {
  const lineCount = countResultLines(resultDisplay);
  if (lineCount !== null) {
    return `${lineCount} line${lineCount !== 1 ? 's' : ''} of output`;
  }
  if (
    resultDisplay &&
    typeof resultDisplay === 'object' &&
    !Array.isArray(resultDisplay)
  ) {
    if ('fileDiff' in resultDisplay) {
      return 'file diff';
    }
    if ('todos' in resultDisplay) {
      return 'todos updated';
    }
  }
  return 'completed';
}

/**
 * Wraps ToolResultDisplay with collapse behavior.
 *
 * When `ui.collapseToolOutput` is true (default), completed tool calls show
 * a single-line summary instead of full output. Errors, cancelled, and
 * in-progress output are always shown in full.
 *
 * The tool name and description are already visible in the StickyHeader,
 * so the collapsed summary only shows the result size.
 */
export const CollapsibleToolResult: React.FC<CollapsibleToolResultProps> = ({
  status,
  resultDisplay,
  ...restProps
}) => {
  const settings = useSettings();
  const collapseByDefault = settings.merged.ui?.collapseToolOutput ?? true;

  const isError = status === CoreToolCallStatus.Error;
  const isCancelled = status === CoreToolCallStatus.Cancelled;
  const isExecuting = status === CoreToolCallStatus.Executing;
  const hasNoResult = resultDisplay === undefined || resultDisplay === '';

  // Only collapse completed, successful tool results
  const shouldCollapse =
    collapseByDefault &&
    !isError &&
    !isCancelled &&
    !isExecuting &&
    !hasNoResult &&
    status === CoreToolCallStatus.Success;

  if (!shouldCollapse) {
    return <ToolResultDisplay resultDisplay={resultDisplay} {...restProps} />;
  }

  const summary = formatSummary(resultDisplay);

  return (
    <Box height={1} overflow="hidden">
      <Text color={theme.text.secondary} wrap="truncate" dimColor>
        {summary}
      </Text>
    </Box>
  );
};
