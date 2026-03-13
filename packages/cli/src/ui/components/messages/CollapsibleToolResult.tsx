/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import {
  ToolResultDisplay,
  type ToolResultDisplayProps,
} from './ToolResultDisplay.js';
import { useSettings } from '../../contexts/SettingsContext.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import { CoreToolCallStatus } from '@google/gemini-cli-core';
import { theme } from '../../semantic-colors.js';
import { formatCommand } from '../../utils/keybindingUtils.js';
import { Command } from '../../key/keyBindings.js';

export interface CollapsibleToolResultProps extends ToolResultDisplayProps {
  /** Tool call status — errors are always shown expanded. */
  status: CoreToolCallStatus;
  /** Tool name — used for context-aware summary. */
  toolName?: string;
  /** Tool description — used for content preview in collapsed view. */
  toolDescription?: string;
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

const MAX_PREVIEW_LENGTH = 60;

/**
 * Extracts a short first-line preview from string output.
 */
function getFirstLinePreview(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed) return null;
  const firstLine = trimmed.split('\n')[0].trim();
  if (!firstLine) return null;
  if (firstLine.length <= MAX_PREVIEW_LENGTH) return firstLine;
  return firstLine.slice(0, MAX_PREVIEW_LENGTH) + '…';
}

/**
 * Builds a compact summary of the tool output with a content preview.
 */
function formatSummary(
  resultDisplay: ToolResultDisplayProps['resultDisplay'],
): string {
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

  const lineCount = countResultLines(resultDisplay);
  if (lineCount !== null) {
    const countLabel = `${lineCount} line${lineCount !== 1 ? 's' : ''}`;
    // Extract a first-line preview for context
    let raw = '';
    if (typeof resultDisplay === 'string') {
      raw = resultDisplay;
    } else if (Array.isArray(resultDisplay)) {
      const first: unknown = resultDisplay[0];
      raw = typeof first === 'string' ? first : '';
    }
    const preview = getFirstLinePreview(raw);
    if (preview) {
      return `${countLabel} — ${preview}`;
    }
    return `${countLabel} of output`;
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
  toolName: _toolName,
  toolDescription,
  ...restProps
}) => {
  const settings = useSettings();
  const { toolOutputExpanded } = useUIState();
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

  // Show progress info while the tool is executing
  if (isExecuting) {
    if (hasNoResult) {
      // No output yet — show the tool description as a progress hint
      return toolDescription ? (
        <Box height={1} overflow="hidden">
          <Text color={theme.text.secondary} dimColor wrap="truncate">
            {toolDescription}
          </Text>
        </Box>
      ) : null;
    }
    const lineCount = countResultLines(resultDisplay);
    return (
      <>
        <ToolResultDisplay resultDisplay={resultDisplay} {...restProps} />
        {lineCount !== null && lineCount > 0 && (
          <Box height={1} overflow="hidden">
            <Text color={theme.text.secondary} dimColor wrap="truncate">
              {lineCount} line{lineCount !== 1 ? 's' : ''} so far…
            </Text>
          </Box>
        )}
      </>
    );
  }

  if (!shouldCollapse || toolOutputExpanded) {
    return <ToolResultDisplay resultDisplay={resultDisplay} {...restProps} />;
  }

  const summary = formatSummary(resultDisplay);
  const expandHint = formatCommand(Command.TOGGLE_TOOL_EXPAND);

  return (
    <Box height={1} overflow="hidden">
      <Text color={theme.text.secondary} wrap="truncate" dimColor>
        {summary} ({expandHint} to expand)
      </Text>
    </Box>
  );
};
