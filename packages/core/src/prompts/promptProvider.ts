/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { HierarchicalMemory } from '../config/memory.js';
import { GEMINI_DIR } from '../utils/paths.js';
import { ApprovalMode } from '../policy/types.js';
import * as snippets from './snippets.js';
import * as legacySnippets from './snippets.legacy.js';
import {
  resolvePathFromEnv,
  applySubstitutions,
  isSectionEnabled,
  type ResolvedPath,
} from './utils.js';
import { CodebaseInvestigatorAgent } from '../agents/codebase-investigator.js';
import { isGitRepository } from '../utils/gitUtils.js';
import {
  WRITE_TODOS_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
} from '../tools/tool-names.js';
import { resolveModel, supportsModernFeatures } from '../config/models.js';
import type { Config } from '../config/config.js';
import { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import { getAllGeminiMdFilenames } from '../tools/memoryTool.js';
import { RepoMapService } from '../services/repoMapService.js';
import { detectRepoMapTrigger } from '../services/repoMapTrigger.js';
import { OncallOrchestratorService } from '../services/oncallOrchestratorService.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';

/** Max repo map injection size in characters (~3KB). */
const REPO_MAP_MAX_CHARS = 3072;

/** Approximate chars-per-token for budget calculation. */
const CHARS_PER_TOKEN = 4;

/**
 * Orchestrates prompt generation by gathering context and building options.
 */
export class PromptProvider {
  private repoMapService = new RepoMapService();
  private oncallOrchestrator = new OncallOrchestratorService();

  /**
   * Build a `<repo_map>` context block for the given user prompt, if a
   * trigger is detected. Returns an empty string when no map is relevant.
   *
   * Call this per-turn and inject the result alongside dynamic context.
   *
   * @param prompt   The raw user prompt text.
   * @param rootDir  The project root directory.
   */
  async getRepoMapContext(prompt: string, rootDir: string): Promise<string> {
    const scope = detectRepoMapTrigger(prompt, rootDir);
    if (!scope) return '';

    try {
      const map = await this.repoMapService.buildScopedMap(rootDir, scope);
      if (map.files.length === 0) return '';

      const maxTokens = Math.floor(REPO_MAP_MAX_CHARS / CHARS_PER_TOKEN);
      const condensed = this.repoMapService.getCondensedMap(map, maxTokens);
      if (!condensed.trim()) return '';

      return `<repo_map scope="${scope.kind}:${path.relative(rootDir, scope.target)}">\n${condensed}\n</repo_map>`;
    } catch {
      // Repo map is best-effort; never break the prompt pipeline.
      return '';
    }
  }

  /** Invalidate repo map cache for a directory (e.g. after file mutations). */
  invalidateRepoMap(dirPath: string): void {
    this.repoMapService.invalidateScope(dirPath);
  }

  /**
   * Checks user prompt for production issue signals and returns an
   * investigation prompt injection if a trigger is detected.
   *
   * The returned string is a self-contained investigation guide that should
   * be appended to the system instruction for the current turn. It tells the
   * model WHAT to investigate and HOW, using existing MCP production tools.
   *
   * Returns an empty string when no oncall trigger is detected.
   *
   * @param userPrompt The raw user prompt text.
   */
  getOncallInvestigationContext(userPrompt: string): string {
    const trigger = this.oncallOrchestrator.detectOncallTrigger(userPrompt);
    if (!trigger) return '';

    return this.oncallOrchestrator.generateInvestigationPrompt(trigger);
  }

  /**
   * Generates the core system prompt.
   */
  getCoreSystemPrompt(
    context: AgentLoopContext,
    userMemory?: string | HierarchicalMemory,
    interactiveOverride?: boolean,
  ): string {
    const systemMdResolution = resolvePathFromEnv(
      process.env['GEMINI_SYSTEM_MD'],
    );

    const interactiveMode =
      interactiveOverride ?? context.config.isInteractive();
    const approvalMode =
      context.config.getApprovalMode?.() ?? ApprovalMode.DEFAULT;
    const isPlanMode = approvalMode === ApprovalMode.PLAN;
    const isYoloMode = approvalMode === ApprovalMode.YOLO;
    const skills = context.config.getSkillManager().getSkills();
    const toolNames = context.toolRegistry.getAllToolNames();
    const enabledToolNames = new Set(toolNames);
    const approvedPlanPath = context.config.getApprovedPlanPath();

    const desiredModel = resolveModel(
      context.config.getActiveModel(),
      context.config.getGemini31LaunchedSync?.() ?? false,
    );
    const isModernModel = supportsModernFeatures(desiredModel);
    const activeSnippets = isModernModel ? snippets : legacySnippets;
    const contextFilenames = getAllGeminiMdFilenames();

    // --- Context Gathering ---
    let planModeToolsList = '';
    if (isPlanMode) {
      const allTools = context.toolRegistry.getAllTools();
      planModeToolsList = allTools
        .map((t) => {
          if (t instanceof DiscoveredMCPTool) {
            return `  <tool>\`${t.name}\` (${t.serverName})</tool>`;
          }
          return `  <tool>\`${t.name}\`</tool>`;
        })
        .join('\n');
    }

    let basePrompt: string;

    // --- Template File Override ---
    if (systemMdResolution.value && !systemMdResolution.isDisabled) {
      let systemMdPath = path.resolve(path.join(GEMINI_DIR, 'system.md'));
      if (!systemMdResolution.isSwitch) {
        systemMdPath = systemMdResolution.value;
      }
      if (!fs.existsSync(systemMdPath)) {
        throw new Error(`missing system prompt file '${systemMdPath}'`);
      }
      basePrompt = fs.readFileSync(systemMdPath, 'utf8');
      const skillsPrompt = activeSnippets.renderAgentSkills(
        skills.map((s) => ({
          name: s.name,
          description: s.description,
          location: s.location,
        })),
      );
      basePrompt = applySubstitutions(
        basePrompt,
        context.config,
        skillsPrompt,
        isModernModel,
      );
    } else {
      // --- Standard Composition ---
      const hasHierarchicalMemory =
        typeof userMemory === 'object' &&
        userMemory !== null &&
        (!!userMemory.global?.trim() ||
          !!userMemory.extension?.trim() ||
          !!userMemory.project?.trim());

      const options: snippets.SystemPromptOptions = {
        preamble: this.withSection('preamble', () => ({
          interactive: interactiveMode,
        })),
        coreMandates: this.withSection('coreMandates', () => ({
          interactive: interactiveMode,
          hasSkills: skills.length > 0,
          hasHierarchicalMemory,
          contextFilenames,
        })),
        subAgents: this.withSection('agentContexts', () =>
          context.config
            .getAgentRegistry()
            .getAllDefinitions()
            .map((d) => ({
              name: d.name,
              description: d.description,
            })),
        ),
        agentSkills: this.withSection(
          'agentSkills',
          () =>
            skills.map((s) => ({
              name: s.name,
              description: s.description,
              location: s.location,
            })),
          skills.length > 0,
        ),
        hookContext: isSectionEnabled('hookContext') || undefined,
        primaryWorkflows: this.withSection(
          'primaryWorkflows',
          () => ({
            interactive: interactiveMode,
            enableCodebaseInvestigator: enabledToolNames.has(
              CodebaseInvestigatorAgent.name,
            ),
            enableWriteTodosTool: enabledToolNames.has(WRITE_TODOS_TOOL_NAME),
            enableEnterPlanModeTool: enabledToolNames.has(
              ENTER_PLAN_MODE_TOOL_NAME,
            ),
            enableGrep: enabledToolNames.has(GREP_TOOL_NAME),
            enableGlob: enabledToolNames.has(GLOB_TOOL_NAME),
            approvedPlan: approvedPlanPath
              ? { path: approvedPlanPath }
              : undefined,
            taskTracker: context.config.isTrackerEnabled(),
          }),
          !isPlanMode,
        ),
        planningWorkflow: this.withSection(
          'planningWorkflow',
          () => {
            // Get step execution prompt if a plan is actively being executed
            const planExecService = context.config.getPlanExecutionService?.();
            const stepExecutionPrompt =
              planExecService?.isExecuting()
                ? planExecService.getStepPrompt()
                : undefined;

            return {
              planModeToolsList,
              plansDir: context.config.storage.getPlansDir(),
              approvedPlanPath: context.config.getApprovedPlanPath(),
              taskTracker: context.config.isTrackerEnabled(),
              stepExecutionPrompt,
            };
          },
          isPlanMode,
        ),
        taskTracker: context.config.isTrackerEnabled(),
        operationalGuidelines: this.withSection(
          'operationalGuidelines',
          () => ({
            interactive: interactiveMode,
            enableShellEfficiency:
              context.config.getEnableShellOutputEfficiency(),
            interactiveShellEnabled: context.config.isInteractiveShellEnabled(),
            lintPrompt: context.config.getLintService().formatLintPrompt(),
            verifyPrompt: context.config.getVerifyLoopService().formatVerifyPrompt(),
          }),
        ),
        sandbox: this.withSection('sandbox', () => getSandboxMode()),
        interactiveYoloMode: this.withSection(
          'interactiveYoloMode',
          () => true,
          isYoloMode && interactiveMode,
        ),
        gitRepo: this.withSection(
          'git',
          () => ({ interactive: interactiveMode }),
          isGitRepository(process.cwd()) ? true : false,
        ),
        finalReminder: isModernModel
          ? undefined
          : this.withSection('finalReminder', () => ({
              readFileToolName: READ_FILE_TOOL_NAME,
            })),
      } as snippets.SystemPromptOptions;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const getCoreSystemPrompt = activeSnippets.getCoreSystemPrompt as (
        options: snippets.SystemPromptOptions,
      ) => string;
      basePrompt = getCoreSystemPrompt(options);
    }

    // --- Finalization (Shell) ---
    const finalPrompt = activeSnippets.renderFinalShell(
      basePrompt,
      userMemory,
      contextFilenames,
    );

    // Sanitize erratic newlines from composition
    const sanitizedPrompt = finalPrompt.replace(/\n{3,}/g, '\n\n');

    // Write back to file if requested
    this.maybeWriteSystemMd(
      sanitizedPrompt,
      systemMdResolution,
      path.resolve(path.join(GEMINI_DIR, 'system.md')),
    );

    return sanitizedPrompt;
  }

  getCompressionPrompt(config: Config, customInstructions?: string): string {
    const desiredModel = resolveModel(
      config.getActiveModel(),
      config.getGemini31LaunchedSync?.() ?? false,
    );
    const isModernModel = supportsModernFeatures(desiredModel);
    const activeSnippets = isModernModel ? snippets : legacySnippets;
    return activeSnippets.getCompressionPrompt(
      customInstructions,
      config.getApprovedPlanPath(),
    );
  }

  private withSection<T>(
    key: string,
    factory: () => T,
    guard: boolean = true,
  ): T | undefined {
    return guard && isSectionEnabled(key) ? factory() : undefined;
  }

  private maybeWriteSystemMd(
    basePrompt: string,
    resolution: ResolvedPath,
    defaultPath: string,
  ): void {
    const writeSystemMdResolution = resolvePathFromEnv(
      process.env['GEMINI_WRITE_SYSTEM_MD'],
    );
    if (writeSystemMdResolution.value && !writeSystemMdResolution.isDisabled) {
      const writePath = writeSystemMdResolution.isSwitch
        ? defaultPath
        : writeSystemMdResolution.value;
      fs.mkdirSync(path.dirname(writePath), { recursive: true });
      fs.writeFileSync(writePath, basePrompt);
    }
  }
}

// --- Internal Context Helpers ---

function getSandboxMode(): snippets.SandboxMode {
  if (process.env['SANDBOX'] === 'sandbox-exec') return 'macos-seatbelt';
  if (process.env['SANDBOX']) return 'generic';
  return 'outside';
}
