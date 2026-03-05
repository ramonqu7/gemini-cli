/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Oncall Debugging Orchestrator
 *
 * Auto-detects production issue signals in user prompts and generates
 * investigation prompt injections that guide the model to gather context
 * from multiple internal systems in parallel.
 *
 * This service does NOT make tool calls itself — it produces system prompt
 * fragments that tell the model WHAT to investigate and HOW, using the
 * available MCP production tools (monarch, IRM, aircat, etc.).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Category of production issue detected from user prompt. */
export type OncallTriggerCategory =
  | 'incident'
  | 'alert'
  | 'error-rate'
  | 'latency'
  | 'bq-reservation'
  | 'rollout'
  | 'bug-reference'
  | 'general-oncall';

/** Extracted context from a triggered oncall pattern. */
export interface OncallContext {
  /** Which category of issue was detected. */
  category: OncallTriggerCategory;
  /** The regex pattern that matched. */
  matchedPattern: string;
  /** Extracted identifiers (IRM IDs, bug IDs, service names, etc.). */
  extractedIds: string[];
  /** Whether this appears to be BQ-related (triggers BQ investigation patterns). */
  isBqRelated: boolean;
  /** Raw matched text from the user prompt. */
  rawMatch: string;
}

/** A plan for parallel investigation via MCP tools. */
export interface InvestigationPlan {
  /** MCP tool calls the model should make. */
  contextGathering: string[];
  /** Memory/knowledge queries to run for historical context. */
  historicalSearch: string[];
  /** Specialized agent to spawn, if applicable. */
  domainAgent?: string;
}

// ---------------------------------------------------------------------------
// Trigger Patterns
// ---------------------------------------------------------------------------

interface TriggerPattern {
  regex: RegExp;
  category: OncallTriggerCategory;
  /** Optional extractor for IDs from the match. */
  extractIds?: (match: RegExpMatchArray) => string[];
}

const ONCALL_TRIGGERS: TriggerPattern[] = [
  {
    regex: /\b(alert|page|pager|outage|incident)\b/i,
    category: 'alert',
  },
  {
    regex: /\b(IRM-(\d+)|irm\/(\d+))\b/i,
    category: 'incident',
    extractIds: (m) => [m[2] ?? m[3]].filter(Boolean),
  },
  {
    regex: /\b(b\/(\d+))\b/i,
    category: 'bug-reference',
    extractIds: (m) => [m[2]].filter(Boolean),
  },
  {
    regex: /\b(error[\s._-]?rate|latency[\s._-]?spike|500s|timeout(?:s|ing)?)\b/i,
    category: 'error-rate',
  },
  {
    regex: /\b(slot[\s._-]?utilization|queries?[\s._-]?queuing|reservation)\b/i,
    category: 'bq-reservation',
  },
  {
    regex: /\b(oncall|on-call|production[\s._-]?issue)\b/i,
    category: 'general-oncall',
  },
  {
    regex: /\b(rollback|rollout[\s._-]?stuck|canary[\s._-]?fail(?:ure|ed|ing)?)\b/i,
    category: 'rollout',
  },
];

/** Keywords that suggest BQ / BigQuery context. */
const BQ_KEYWORDS =
  /\b(bigquery|bq|dremel|slot|reservation|wlm|query[\s._-]?queue|helixdata)\b/i;

// ---------------------------------------------------------------------------
// Investigation Templates
// ---------------------------------------------------------------------------

/** Maps a category to the recommended MCP tools and investigation steps. */
const INVESTIGATION_TEMPLATES: Record<
  OncallTriggerCategory,
  { tools: string[]; steps: string[] }
> = {
  incident: {
    tools: [
      'search_irm_incidents',
      'get_irm_details',
      'monarch_query',
      'get_production_changes',
      'oncall_overview',
    ],
    steps: [
      'Retrieve IRM incident details with get_irm_details',
      'Query error/latency metrics with monarch_query for the affected service',
      'Check recent production changes with get_production_changes',
      'Review oncall overview for related active incidents',
    ],
  },
  alert: {
    tools: [
      'search_irm_incidents',
      'search_irm_signals',
      'monarch_query',
      'oncall_overview',
      'get_production_changes',
    ],
    steps: [
      'Search for active IRM incidents matching the alert',
      'Search IRM signals for correlated alerts',
      'Query relevant metrics with monarch_query',
      'Check oncall overview for team incident state',
      'Review recent production changes for potential causes',
    ],
  },
  'error-rate': {
    tools: [
      'monarch_query',
      'search_irm_incidents',
      'get_production_changes',
      'aircat',
    ],
    steps: [
      'Query error rate metrics with monarch_query (specify metric name)',
      'Search IRM for any auto-filed incidents related to the error spike',
      'Review recent production changes for deployments that coincide',
      'Check aircat for anomalous traffic patterns',
    ],
  },
  latency: {
    tools: [
      'monarch_query',
      'search_irm_incidents',
      'get_production_changes',
    ],
    steps: [
      'Query latency percentile metrics (p50/p99) with monarch_query',
      'Check IRM for latency-related incidents',
      'Review recent production changes and rollouts',
    ],
  },
  'bq-reservation': {
    tools: [
      'monarch_query',
      'mash_query',
      'search_irm_incidents',
      'get_production_changes',
    ],
    steps: [
      'Query slot utilization via mash_query with reservation filter',
      'Query queue cost metrics via mash_query',
      'Check IRM for BQ reservation incidents',
      'Review BQ production changes',
    ],
  },
  rollout: {
    tools: [
      'sisyphus_list_rollouts',
      'sisyphus_get_rollout_details',
      'get_production_changes',
      'monarch_query',
      'search_irm_incidents',
    ],
    steps: [
      'List recent rollouts with sisyphus_list_rollouts',
      'Get details of stuck/failing rollout with sisyphus_get_rollout_details',
      'Check production changes timeline',
      'Query health metrics to assess rollout impact',
      'Search IRM for rollout-triggered incidents',
    ],
  },
  'bug-reference': {
    tools: [
      'get_bugs',
      'search_irm_incidents',
      'monarch_query',
    ],
    steps: [
      'Fetch bug details with get_bugs',
      'Cross-reference with IRM if the bug is production-impacting',
      'Query relevant metrics if the bug describes a performance regression',
    ],
  },
  'general-oncall': {
    tools: [
      'oncall_overview',
      'search_irm_incidents',
      'search_irm_signals',
      'monarch_query',
      'get_production_changes',
    ],
    steps: [
      'Get oncall overview for current incident state',
      'Search for active IRM incidents',
      'Search IRM signals for recent alerts',
      'Review production changes from the last 24 hours',
    ],
  },
};

// ---------------------------------------------------------------------------
// BQ Investigation Patterns (from CLAUDE.md)
// ---------------------------------------------------------------------------

const BQ_INVESTIGATION_SUPPLEMENT = `
## BQ Investigation Patterns
When investigating BigQuery/reservation issues, use these known patterns:
- **Slot allocation Mash query**: Use mash_query with metric pattern matching reservation names
- **Queue cost Mash query**: Use mash_query to check query cost by category
- **BQ queries**: Use project helixdata2-tmp for BQ queries (F1 fails on INTERVAL). Chunk 7-9 day ranges.
- **Key fields**: reservation_id is a STRUCT in statistics.reservation, query cell is in statistics.extended
- Cross-reference slot utilization trends with query queuing events to identify capacity issues
`;

// ---------------------------------------------------------------------------
// Production Debugging Protocol (injected into snippets)
// ---------------------------------------------------------------------------

export const PRODUCTION_DEBUGGING_PROTOCOL = `
## Production Debugging Protocol
When investigating a production issue:
1. Gather context FIRST (metrics, incidents, recent changes) -- use batch tools for parallel queries
2. Correlate: timeline of changes vs symptom onset
3. Narrow: which service, endpoint, change caused it
4. Mitigate BEFORE root cause (stop the bleeding)
5. Root cause: trace the exact failure path
6. Document: file bug, update runbook if needed

Always check knowledge base for similar past incidents before starting fresh investigation.
`.trim();

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class OncallOrchestratorService {
  /**
   * Scans a user prompt for production issue signals.
   * Returns the first (highest-priority) match, or null if none found.
   */
  detectOncallTrigger(userPrompt: string): OncallContext | null {
    for (const trigger of ONCALL_TRIGGERS) {
      const match = trigger.regex.exec(userPrompt);
      if (match) {
        return {
          category: trigger.category,
          matchedPattern: trigger.regex.source,
          extractedIds: trigger.extractIds ? trigger.extractIds(match) : [],
          isBqRelated: BQ_KEYWORDS.test(userPrompt),
          rawMatch: match[0],
        };
      }
    }
    return null;
  }

  /**
   * Builds a parallel investigation plan based on the detected trigger.
   */
  buildInvestigationPlan(trigger: OncallContext): InvestigationPlan {
    const template = INVESTIGATION_TEMPLATES[trigger.category];

    const plan: InvestigationPlan = {
      contextGathering: [...template.tools],
      historicalSearch: [
        'Search knowledge base for similar past incidents',
        'Search Alaric memory for oncall learnings and gotchas',
      ],
    };

    // Add BQ-specific tools if BQ-related
    if (trigger.isBqRelated && trigger.category !== 'bq-reservation') {
      plan.contextGathering.push('mash_query');
      plan.historicalSearch.push(
        'Search for BQ reservation investigation patterns',
      );
    }

    // Assign domain agent for BQ reservation issues
    if (
      trigger.category === 'bq-reservation' ||
      trigger.isBqRelated
    ) {
      plan.domainAgent = 'bq-reservation-wlm-oncall';
    }

    return plan;
  }

  /**
   * Generates a system prompt injection for the detected oncall trigger.
   *
   * The injection guides the model on WHAT to investigate and HOW,
   * using existing MCP tools. It stays under 2KB.
   */
  generateInvestigationPrompt(trigger: OncallContext): string {
    const template = INVESTIGATION_TEMPLATES[trigger.category];
    const plan = this.buildInvestigationPlan(trigger);

    const categoryLabel = trigger.category.replace(/-/g, ' ');
    const idsSuffix =
      trigger.extractedIds.length > 0
        ? ` (${trigger.extractedIds.join(', ')})`
        : '';

    const steps = template.steps
      .map((step, i) => `${i + 1}. ${step}`)
      .join('\n');

    const toolsList = plan.contextGathering.join(', ');

    let prompt = `## Active Investigation
Detected: ${categoryLabel}${idsSuffix}
Trigger: "${trigger.rawMatch}"

Recommended investigation steps:
${steps}

Available tools for this investigation: ${toolsList}

Cross-reference with historical patterns from knowledge base.
Use parallel tool calls to gather context simultaneously.
Present findings as a structured investigation summary with:
- Timeline of events
- Affected services/endpoints
- Probable cause
- Recommended mitigation`;

    // Add BQ supplement if relevant
    if (trigger.isBqRelated) {
      prompt += '\n' + BQ_INVESTIGATION_SUPPLEMENT.trim();
    }

    // Add domain agent hint
    if (plan.domainAgent) {
      prompt += `\n\nSpecialized agent available: ${plan.domainAgent} -- consider delegating detailed investigation.`;
    }

    // Enforce 2KB limit
    if (prompt.length > 2048) {
      prompt = prompt.slice(0, 2045) + '...';
    }

    return prompt;
  }
}
