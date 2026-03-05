/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import {
  shortenPath,
  tildeifyPath,
  getDisplayString,
} from '@google/gemini-cli-core';
import { ConsoleSummaryDisplay } from './ConsoleSummaryDisplay.js';
import process from 'node:process';
import { MemoryUsageDisplay } from './MemoryUsageDisplay.js';
import { ContextUsageDisplay } from './ContextUsageDisplay.js';
import { QuotaDisplay } from './QuotaDisplay.js';
import { DebugProfiler } from './DebugProfiler.js';
import { isDevelopment } from '../../utils/installationInfo.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useVimMode } from '../contexts/VimModeContext.js';

export const Footer: React.FC = () => {
  const uiState = useUIState();
  const config = useConfig();
  const settings = useSettings();
  const { vimEnabled, vimMode } = useVimMode();

  const {
    model,
    targetDir,
    debugMode,
    branchName,
    debugMessage,
    corgiMode,
    errorCount,
    showErrorDetails,
    promptTokenCount,
    isTrustedFolder,
    terminalWidth,
    quotaStats,
  } = {
    model: uiState.currentModel,
    targetDir: config.getTargetDir(),
    debugMode: config.getDebugMode(),
    branchName: uiState.branchName,
    debugMessage: uiState.debugMessage,
    corgiMode: uiState.corgiMode,
    errorCount: uiState.errorCount,
    showErrorDetails: uiState.showErrorDetails,
    promptTokenCount: uiState.sessionStats.lastPromptTokenCount,
    isTrustedFolder: uiState.isTrustedFolder,
    terminalWidth: uiState.terminalWidth,
    quotaStats: uiState.quota.stats,
  };

  const showMemoryUsage =
    config.getDebugMode() || settings.merged.ui.showMemoryUsage;
  const isFullErrorVerbosity = settings.merged.ui.errorVerbosity === 'full';
  const showErrorSummary =
    !showErrorDetails &&
    errorCount > 0 &&
    (isFullErrorVerbosity || debugMode || isDevelopment);
  const hideCWD = settings.merged.ui.footer.hideCWD;
  const hideSandboxStatus = settings.merged.ui.footer.hideSandboxStatus;
  const hideModelInfo = settings.merged.ui.footer.hideModelInfo;
  const hideContextPercentage = settings.merged.ui.footer.hideContextPercentage;

  const pathLength = Math.max(20, Math.floor(terminalWidth * 0.25));
  const displayPath = shortenPath(tildeifyPath(targetDir), pathLength);

  const justifyContent = hideCWD && hideModelInfo ? 'center' : 'space-between';
  const displayVimMode = vimEnabled ? vimMode : undefined;

  const showDebugProfiler = debugMode || isDevelopment;

  if (settings.merged.ui.footerLayoutRefresh) {
    return (
      <Box
        width={terminalWidth}
        height={2}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
        paddingX={1}
        paddingTop={0}
        paddingBottom={0}
      >
        <Box flexDirection="column" flexShrink={1} paddingRight={2}>
          <Text color={theme.text.secondary} wrap="truncate-end">
            /directory
          </Text>
          <Box flexDirection="row" alignItems="center">
            <Text color={theme.text.primary} wrap="truncate-end">
              {displayVimMode && (
                <Text color={theme.text.secondary}>[{displayVimMode}] </Text>
              )}
              {displayPath}
              {debugMode && (
                <Text color={theme.status.error}>
                  {' '}
                  {' ' + (debugMessage || '--debug')}
                </Text>
              )}
            </Text>
            {showDebugProfiler && (
              <Box marginLeft={1} flexShrink={0}>
                <DebugProfiler />
              </Box>
            )}
          </Box>
        </Box>

        {branchName && (
          <Box flexDirection="column" flexShrink={0} paddingRight={2}>
            <Text color={theme.text.secondary} wrap="truncate-end">
              branch
            </Text>
            <Text color={theme.text.primary} wrap="truncate-end">
              {branchName}
            </Text>
          </Box>
        )}

        {!hideSandboxStatus && (
          <Box flexDirection="column" flexShrink={0} paddingRight={2}>
            <Text color={theme.text.secondary} wrap="truncate-end">
              sandbox
            </Text>
            {isTrustedFolder === false ? (
              <Text color={theme.status.warning} wrap="truncate-end">
                untrusted
              </Text>
            ) : process.env['SANDBOX'] &&
              process.env['SANDBOX'] !== 'sandbox-exec' ? (
              <Text color="green" wrap="truncate-end">
                {process.env['SANDBOX'].replace(/^gemini-(?:cli-)?/, '')}
              </Text>
            ) : process.env['SANDBOX'] === 'sandbox-exec' ? (
              <Text color={theme.status.warning} wrap="truncate-end">
                macOS Seatbelt
              </Text>
            ) : (
              <Text color={theme.status.error} wrap="truncate-end">
                no sandbox
              </Text>
            )}
          </Box>
        )}

        {!hideModelInfo && (
          <Box flexDirection="column" flexShrink={0} paddingRight={2}>
            <Text color={theme.text.secondary} wrap="truncate-end">
              /model
            </Text>
            <Box flexDirection="row" alignItems="center">
              <Text color={theme.text.primary} wrap="truncate-end">
                {getDisplayString(model)}
              </Text>
              {corgiMode && <Text color={theme.status.error}> ▼(´ᴥ`)▼</Text>}
            </Box>
          </Box>
        )}

        {!hideModelInfo && !hideContextPercentage && (
          <Box
            flexDirection="column"
            flexShrink={0}
            paddingRight={showMemoryUsage || showErrorSummary ? 2 : 0}
          >
            <Text color={theme.text.secondary} wrap="truncate-end">
              context
            </Text>
            <Box flexDirection="row">
              <ContextUsageDisplay
                promptTokenCount={promptTokenCount}
                model={model}
                terminalWidth={terminalWidth}
              />
              {quotaStats && (
                <Text wrap="truncate-end">
                  {' '}
                  <QuotaDisplay
                    remaining={quotaStats.remaining}
                    limit={quotaStats.limit}
                    resetTime={quotaStats.resetTime}
                    terse={true}
                  />
                </Text>
              )}
            </Box>
          </Box>
        )}

        {(showMemoryUsage || showErrorSummary) && (
          <Box flexDirection="column" flexShrink={0}>
            <Text color={theme.text.secondary} wrap="truncate-end">
              session info
            </Text>
            <Box flexDirection="row">
              {showMemoryUsage && <MemoryUsageDisplay />}
              {showMemoryUsage && showErrorSummary && (
                <Text color={theme.text.secondary}> · </Text>
              )}
              {showErrorSummary && (
                <Box paddingLeft={0} flexShrink={0}>
                  <ConsoleSummaryDisplay errorCount={errorCount} />
                </Box>
              )}
            </Box>
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box
      justifyContent={justifyContent}
      width={terminalWidth}
      flexDirection="row"
      alignItems="center"
      paddingX={1}
      paddingBottom={0}
      marginBottom={0}
    >
      {(showDebugProfiler || displayVimMode || !hideCWD) && (
        <Box>
          {showDebugProfiler && <DebugProfiler />}
          {displayVimMode && (
            <Text color={theme.text.secondary}>[{displayVimMode}] </Text>
          )}
          {!hideCWD && (
            <Text color={theme.text.primary}>
              {displayPath}
              {branchName && (
                <Text color={theme.text.secondary}> ({branchName}*)</Text>
              )}
            </Text>
          )}
          {debugMode && (
            <Text color={theme.status.error}>
              {' ' + (debugMessage || '--debug')}
            </Text>
          )}
        </Box>
      )}

      {/* Middle Section: Centered Trust/Sandbox Info */}
      {!hideSandboxStatus && (
        <Box
          flexGrow={1}
          alignItems="center"
          justifyContent="center"
          display="flex"
        >
          {isTrustedFolder === false ? (
            <Text color={theme.status.warning}>untrusted</Text>
          ) : process.env['SANDBOX'] &&
            process.env['SANDBOX'] !== 'sandbox-exec' ? (
            <Text color="green">
              {process.env['SANDBOX'].replace(/^gemini-(?:cli-)?/, '')}
            </Text>
          ) : process.env['SANDBOX'] === 'sandbox-exec' ? (
            <Text color={theme.status.warning}>
              macOS Seatbelt{' '}
              <Text color={theme.text.secondary}>
                ({process.env['SEATBELT_PROFILE']})
              </Text>
            </Text>
          ) : (
            <Text color={theme.status.error}>
              no sandbox
              {terminalWidth >= 100 && (
                <Text color={theme.text.secondary}> (see /docs)</Text>
              )}
            </Text>
          )}
        </Box>
      )}

      {/* Right Section: Gemini Label and Console Summary */}
      {!hideModelInfo && (
        <Box alignItems="center" justifyContent="flex-end">
          <Box alignItems="center">
            <Text color={theme.text.primary}>
              <Text color={theme.text.secondary}>/model </Text>
              {getDisplayString(model)}
              {!hideContextPercentage && (
                <>
                  {' '}
                  <ContextUsageDisplay
                    promptTokenCount={promptTokenCount}
                    model={model}
                    terminalWidth={terminalWidth}
                  />
                </>
              )}
              {quotaStats && (
                <>
                  {' '}
                  <QuotaDisplay
                    remaining={quotaStats.remaining}
                    limit={quotaStats.limit}
                    resetTime={quotaStats.resetTime}
                    terse={true}
                  />
                </>
              )}
            </Text>
            {showMemoryUsage && (
              <Box flexDirection="row">
                <Text color={theme.ui.comment}> | </Text>
                <MemoryUsageDisplay />
              </Box>
            )}
          </Box>
          <Box alignItems="center">
            {corgiMode && (
              <Box paddingLeft={1} flexDirection="row">
                <Text>
                  <Text color={theme.ui.symbol}>| </Text>
                  <Text color={theme.status.error}>▼</Text>
                  <Text color={theme.text.primary}>(´</Text>
                  <Text color={theme.status.error}>ᴥ</Text>
                  <Text color={theme.text.primary}>`)</Text>
                  <Text color={theme.status.error}>▼</Text>
                </Text>
              </Box>
            )}
            {showErrorSummary && (
              <Box paddingLeft={1} flexDirection="row">
                <Text color={theme.ui.comment}>| </Text>
                <ConsoleSummaryDisplay errorCount={errorCount} />
              </Box>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
};
