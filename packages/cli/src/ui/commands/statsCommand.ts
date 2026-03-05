/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  HistoryItemStats,
  HistoryItemModelStats,
  HistoryItemToolStats,
} from '../types.js';
import { MessageType } from '../types.js';
import { formatDuration } from '../utils/formatters.js';
import {
  UserAccountManager,
  getG1CreditBalance,
  tokenBudgetService,
  CommandHistoryService,
  BackgroundIngestionService,
  TeamKnowledgeService,
} from '@google/gemini-cli-core';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';

function getUserIdentity(context: CommandContext) {
  const selectedAuthType =
    context.services.settings.merged.security.auth.selectedType || '';

  const userAccountManager = new UserAccountManager();
  const cachedAccount = userAccountManager.getCachedGoogleAccount();
  const userEmail = cachedAccount ?? undefined;

  const tier = context.services.config?.getUserTierName();
  const paidTier = context.services.config?.getUserPaidTier();
  const creditBalance = getG1CreditBalance(paidTier) ?? undefined;

  return { selectedAuthType, userEmail, tier, creditBalance };
}

async function defaultSessionView(context: CommandContext) {
  const now = new Date();
  const { sessionStartTime } = context.session.stats;
  if (!sessionStartTime) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Session start time is unavailable, cannot calculate stats.',
    });
    return;
  }
  const wallDuration = now.getTime() - sessionStartTime.getTime();

  const { selectedAuthType, userEmail, tier, creditBalance } =
    getUserIdentity(context);
  const currentModel = context.services.config?.getModel();

  const statsItem: HistoryItemStats = {
    type: MessageType.STATS,
    duration: formatDuration(wallDuration),
    selectedAuthType,
    userEmail,
    tier,
    currentModel,
    creditBalance,
  };

  if (context.services.config) {
    const [quota] = await Promise.all([
      context.services.config.refreshUserQuota(),
      context.services.config.refreshAvailableCredits(),
    ]);
    if (quota) {
      statsItem.quotas = quota;
      statsItem.pooledRemaining = context.services.config.getQuotaRemaining();
      statsItem.pooledLimit = context.services.config.getQuotaLimit();
      statsItem.pooledResetTime = context.services.config.getQuotaResetTime();
    }
  }

  context.ui.addItem(statsItem);
}

// ---------------------------------------------------------------------------
// /stats detail — deeper breakdown
// ---------------------------------------------------------------------------

function formatDetailView(context: CommandContext): string {
  const lines: string[] = [];

  lines.push('━━━ Detailed Session Stats ━━━');
  lines.push('');

  // Token usage breakdown
  if (tokenBudgetService.isEnabled()) {
    const snapshot = tokenBudgetService.getUsageSnapshot();
    const cost = tokenBudgetService.getSessionCost();
    const progressBar = tokenBudgetService.getProgressBar(30);

    lines.push('Token Usage:');
    lines.push(`  Input:      ${formatTokenCount(snapshot.totalInputTokens)}`);
    lines.push(`  Output:     ${formatTokenCount(snapshot.totalOutputTokens)}`);
    lines.push(`  Cached:     ${formatTokenCount(snapshot.totalCachedTokens)}`);
    lines.push(`  Thoughts:   ${formatTokenCount(snapshot.totalThoughtsTokens)}`);
    lines.push(`  Total:      ${formatTokenCount(snapshot.totalTokens)}`);
    lines.push(`  API Calls:  ${snapshot.apiCallCount}`);
    lines.push(`  Est. Cost:  ~$${cost.toFixed(4)}`);
    lines.push(`  Context:    ${progressBar}`);
  } else {
    lines.push('Token Usage: N/A (tracking disabled)');
  }

  lines.push('');

  // Session duration
  const now = new Date();
  const { sessionStartTime } = context.session.stats;
  if (sessionStartTime) {
    const wallDuration = now.getTime() - sessionStartTime.getTime();
    lines.push(`Session Duration: ${formatDuration(wallDuration)}`);
  } else {
    lines.push('Session Duration: N/A');
  }

  lines.push('');

  // Command history summary
  try {
    const historyService = new CommandHistoryService();
    const recentHistory = historyService.getHistory(100);
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const thisWeek = recentHistory.filter(
      (h) => new Date(h.timestamp).getTime() > weekAgo,
    );

    lines.push('History:');
    lines.push(`  Total prompts (recent): ${recentHistory.length}`);
    lines.push(`  Prompts this week: ${thisWeek.length}`);

    // Most common prompt prefixes
    const prefixCounts = new Map<string, number>();
    for (const entry of recentHistory.slice(0, 50)) {
      const prefix = entry.prompt.slice(0, 40).trim();
      if (prefix.startsWith('/')) {
        const cmd = prefix.split(/\s/)[0] ?? prefix;
        prefixCounts.set(cmd, (prefixCounts.get(cmd) ?? 0) + 1);
      }
    }
    if (prefixCounts.size > 0) {
      const topCmds = [...prefixCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([cmd, count]) => `${cmd} (${count}x)`)
        .join(', ');
      lines.push(`  Top commands: ${topCmds}`);
    }
  } catch {
    lines.push('History: N/A');
  }

  lines.push('');

  // Ingestion summary
  try {
    const ingestion = new BackgroundIngestionService();
    const counts = ingestion.getItemCounts();
    if (Object.keys(counts).length > 0) {
      lines.push('Ingested Data:');
      for (const [type, count] of Object.entries(counts)) {
        lines.push(`  ${type}: ${count} items`);
      }
    } else {
      lines.push('Ingested Data: No data yet');
    }
  } catch {
    lines.push('Ingested Data: N/A');
  }

  lines.push('');

  // Knowledge base note
  lines.push('Knowledge Base: Use /stats session for profile details');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// /stats team — team knowledge aggregate
// ---------------------------------------------------------------------------

async function formatTeamView(context: CommandContext): Promise<string> {
  const lines: string[] = [];

  lines.push('━━━ Team Knowledge Stats ━━━');
  lines.push('');

  const teamKnowledge = new TeamKnowledgeService();

  // Try to get team sources from settings
  // The settings shape for team knowledge: knowledge.teamSources
  const settings = context.services.settings.merged as Record<string, unknown>;
  const knowledgeSettings = settings['knowledge'] as
    | Record<string, unknown>
    | undefined;
  const teamSources = (knowledgeSettings?.['teamSources'] as string[]) ?? [];

  if (teamSources.length === 0) {
    lines.push('No team knowledge sources configured.');
    lines.push('');
    lines.push('To configure, add to your settings.json:');
    lines.push('  {');
    lines.push('    "knowledge": {');
    lines.push('      "teamSources": ["/path/to/shared/knowledge/"]');
    lines.push('    }');
    lines.push('  }');
    return lines.join('\n');
  }

  teamKnowledge.setSources(teamSources);

  try {
    await teamKnowledge.loadFromSources();
    const stats = teamKnowledge.getStats();

    lines.push(`Sources: ${teamSources.length} configured`);
    for (const source of teamSources) {
      lines.push(`  - ${source}`);
    }
    lines.push('');

    lines.push(`Total Entries: ${stats.totalEntries}`);
    lines.push(`Entries This Week: ${stats.entriesThisWeek}`);
    lines.push('');

    // Category breakdown
    if (Object.keys(stats.categoryCounts).length > 0) {
      lines.push('By Category:');
      for (const [category, count] of Object.entries(stats.categoryCounts)) {
        lines.push(`  ${category}: ${count}`);
      }
      lines.push('');
    }

    // Top contributors
    if (stats.topContributors.length > 0) {
      lines.push('Top Contributors:');
      for (const { author, count } of stats.topContributors) {
        lines.push(`  ${author}: ${count} entries`);
      }
    }
  } catch (error) {
    lines.push(`Error loading team knowledge: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    const m = count / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const k = count / 1_000;
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return `${count}`;
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const statsCommand: SlashCommand = {
  name: 'stats',
  altNames: ['usage'],
  description:
    'Check session stats. Usage: /stats [session|model|tools|detail|team]',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context: CommandContext) => {
    await defaultSessionView(context);
  },
  subCommands: [
    {
      name: 'session',
      description: 'Show session-specific usage statistics',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context: CommandContext) => {
        await defaultSessionView(context);
      },
    },
    {
      name: 'model',
      description: 'Show model-specific usage statistics',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: (context: CommandContext) => {
        const { selectedAuthType, userEmail, tier } = getUserIdentity(context);
        const currentModel = context.services.config?.getModel();
        const pooledRemaining = context.services.config?.getQuotaRemaining();
        const pooledLimit = context.services.config?.getQuotaLimit();
        const pooledResetTime = context.services.config?.getQuotaResetTime();
        context.ui.addItem({
          type: MessageType.MODEL_STATS,
          selectedAuthType,
          userEmail,
          tier,
          currentModel,
          pooledRemaining,
          pooledLimit,
          pooledResetTime,
        } as HistoryItemModelStats);
      },
    },
    {
      name: 'tools',
      description: 'Show tool-specific usage statistics',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: (context: CommandContext) => {
        context.ui.addItem({
          type: MessageType.TOOL_STATS,
        } as HistoryItemToolStats);
      },
    },
    {
      name: 'detail',
      description: 'Show detailed session breakdown (tokens, history, ingestion)',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: (context: CommandContext) => {
        const output = formatDetailView(context);
        context.ui.addItem({
          type: MessageType.INFO,
          text: output,
        });
      },
    },
    {
      name: 'team',
      description: 'Show team knowledge statistics from shared sources',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: async (context: CommandContext) => {
        const output = await formatTeamView(context);
        context.ui.addItem({
          type: MessageType.INFO,
          text: output,
        });
      },
    },
  ],
};
