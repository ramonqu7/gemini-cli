/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Storage } from '../config/storage.js';
import { debugLogger } from '../utils/debugLogger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserProfile {
  preferredLanguages: string[];
  codingStyle: Record<string, string>;
  preferredTools: string[];
  communicationStyle: string;
  expertiseAreas: string[];
  corrections: Array<{ date: string; from: string; to: string }>;
  lastUpdated: number;
}

export interface ProjectKnowledge {
  projectName: string;
  projectPath: string;
  buildCommand: string;
  testCommand: string;
  keyFiles: string[];
  architectureNotes: string[];
  commonIssues: string[];
  lastUpdated: number;
}

export interface Correction {
  date: string;
  from: string;
  to: string;
  raw: string;
}

export interface Decision {
  date: string;
  decision: string;
  context: string;
}

interface ProjectIndex {
  [projectName: string]: string; // project name -> hash
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KNOWLEDGE_DIR = 'knowledge';
const USER_PROFILE_FILE = 'user-profile.json';
const CORRECTIONS_FILE = 'corrections.jsonl';
const DECISIONS_FILE = 'decisions.jsonl';
const EXPERTISE_FILE = 'expertise.json';
const PROJECT_PATTERNS_DIR = 'project-patterns';
const PROJECT_INDEX_FILE = 'index.json';

const MAX_CONTEXT_BYTES = 2048;
const MAX_CORRECTIONS = 200;
const MAX_DECISIONS = 200;
const MAX_ARCHITECTURE_NOTES = 50;
const MAX_COMMON_ISSUES = 30;
const MAX_KEY_FILES = 50;
const PRUNE_AGE_DAYS = 90;

// Correction-detection patterns (lightweight, no LLM calls)
const CORRECTION_PATTERNS: Array<{
  regex: RegExp;
  extractFrom: (m: RegExpMatchArray) => string;
  extractTo: (m: RegExpMatchArray) => string;
}> = [
  {
    // "no, use X instead of Y" / "no, use X not Y"
    regex:
      /\b(?:no|nope|wrong),?\s+(?:use|try)\s+(.+?)\s+(?:instead\s+of|not|rather\s+than)\s+(.+)/i,
    extractFrom: (m) => m[2]!.trim(),
    extractTo: (m) => m[1]!.trim(),
  },
  {
    // "actually, X not Y"
    regex: /\bactually,?\s+(.+?)\s+(?:not|instead\s+of)\s+(.+)/i,
    extractFrom: (m) => m[2]!.trim(),
    extractTo: (m) => m[1]!.trim(),
  },
  {
    // "instead use X" / "instead, use X"
    regex: /\binstead,?\s+(?:use|try|do)\s+(.+)/i,
    extractFrom: (_m) => '',
    extractTo: (m) => m[1]!.trim(),
  },
  {
    // "don't do X" / "don't use X"
    regex: /\bdon'?t\s+(?:do|use|add|include|put)\s+(.+)/i,
    extractFrom: (m) => m[1]!.trim(),
    extractTo: (_m) => '',
  },
  {
    // "I prefer X over Y" / "I prefer X to Y"
    regex: /\bi\s+prefer\s+(.+?)\s+(?:over|to|instead\s+of)\s+(.+)/i,
    extractFrom: (m) => m[2]!.trim(),
    extractTo: (m) => m[1]!.trim(),
  },
];

// Preference-detection patterns for "always/never" style directives
const PREFERENCE_PATTERNS: Array<{
  regex: RegExp;
  extract: (m: RegExpMatchArray) => { key: string; value: string };
}> = [
  {
    regex: /\balways\s+(?:use|do|add|include|prefer)\s+(.+)/i,
    extract: (m) => ({ key: 'always', value: m[1]!.trim() }),
  },
  {
    regex: /\bnever\s+(?:use|do|add|include)\s+(.+)/i,
    extract: (m) => ({ key: 'never', value: m[1]!.trim() }),
  },
];

// Build/test command detection patterns
const BUILD_COMMAND_PATTERNS = [
  /(?:build\s+(?:command|with|using)|to\s+build[,:]?)\s+[`"]?([a-zA-Z][\w\s./-]+)[`"]?/i,
  /(?:run|execute)\s+[`"]?((?:npm|yarn|pnpm|make|cargo|go|bazel|gradle|mvn|blaze)\s+\S+)[`"]?/i,
];

const TEST_COMMAND_PATTERNS = [
  /(?:test\s+(?:command|with|using)|to\s+test[,:]?)\s+[`"]?([a-zA-Z][\w\s./-]+)[`"]?/i,
  /(?:run\s+tests?\s+(?:with|using))\s+[`"]?(\S+)[`"]?/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getKnowledgeDir(): string {
  return path.join(Storage.getGlobalGeminiDir(), KNOWLEDGE_DIR);
}

function getProjectPatternsDir(): string {
  return path.join(getKnowledgeDir(), PROJECT_PATTERNS_DIR);
}

function hashProjectPath(projectPath: string): string {
  return crypto.createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function appendJsonlFile<T>(filePath: string, entry: T): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(filePath, line, 'utf-8');
}

async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

async function pruneJsonlFile<T extends { date: string }>(
  filePath: string,
  maxEntries: number,
): Promise<void> {
  try {
    const entries = await readJsonlFile<T>(filePath);
    if (entries.length <= maxEntries) return;

    const cutoff = Date.now() - PRUNE_AGE_DAYS * 24 * 60 * 60 * 1000;
    let pruned = entries.filter((e) => new Date(e.date).getTime() > cutoff);

    // If still over limit, keep only the most recent
    if (pruned.length > maxEntries) {
      pruned = pruned.slice(pruned.length - maxEntries);
    }

    await ensureDir(path.dirname(filePath));
    const content = pruned.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(filePath, content, 'utf-8');
  } catch {
    // Pruning is best-effort
  }
}

function truncateToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.length <= maxBytes) return text;

  // Find a clean cut point (don't cut mid-line)
  const decoded = new TextDecoder().decode(encoded.slice(0, maxBytes));
  const lastNewline = decoded.lastIndexOf('\n');
  return lastNewline > 0 ? decoded.slice(0, lastNewline) : decoded;
}

function todayISO(): string {
  return new Date().toISOString().split('T')[0]!;
}

// ---------------------------------------------------------------------------
// KnowledgeBaseService
// ---------------------------------------------------------------------------

/**
 * Persistent knowledge base that grows over time, tracks user preferences,
 * project patterns, corrections, and decisions across sessions.
 *
 * All operations are async and non-blocking. Knowledge is stored as
 * JSON/JSONL files under ~/.gemini/knowledge/.
 */
export class KnowledgeBaseService {
  private profileCache: UserProfile | null = null;
  private profileCacheAge: number = 0;
  private readonly CACHE_TTL_MS = 60_000; // 1 minute

  // -------------------------------------------------------------------------
  // Public API: Learning from conversations
  // -------------------------------------------------------------------------

  /**
   * Called after each conversation turn to extract learnings.
   * Uses lightweight pattern matching (no LLM calls).
   */
  async extractLearnings(
    userMessage: string,
    _modelResponse: string,
    toolResults: Array<{ tool: string; args: unknown; result: string }>,
  ): Promise<void> {
    try {
      // 1. Detect and save corrections
      const correction = this.detectCorrection(userMessage);
      if (correction) {
        await this.saveCorrection(correction);
      }

      // 2. Detect preferences ("always/never" directives)
      await this.detectAndSavePreferences(userMessage);

      // 3. Detect build/test commands from tool usage
      await this.detectCommandsFromTools(toolResults);

      // 4. Update expertise based on topics discussed
      await this.updateExpertise(userMessage);
    } catch (error) {
      debugLogger.debug('KnowledgeBase: extractLearnings failed:', error);
    }
  }

  /**
   * Detects user corrections from a message.
   * Returns a Correction object if found, null otherwise.
   */
  detectCorrection(userMessage: string): Correction | null {
    for (const pattern of CORRECTION_PATTERNS) {
      const match = userMessage.match(pattern.regex);
      if (match) {
        return {
          date: todayISO(),
          from: pattern.extractFrom(match),
          to: pattern.extractTo(match),
          raw: userMessage.slice(0, 200),
        };
      }
    }
    return null;
  }

  /**
   * Records a key decision made during the session.
   */
  async recordDecision(decision: string, context: string): Promise<void> {
    try {
      const entry: Decision = {
        date: todayISO(),
        decision: decision.slice(0, 500),
        context: context.slice(0, 500),
      };
      const filePath = path.join(getKnowledgeDir(), DECISIONS_FILE);
      await appendJsonlFile(filePath, entry);
      await pruneJsonlFile<Decision>(filePath, MAX_DECISIONS);
    } catch (error) {
      debugLogger.debug('KnowledgeBase: recordDecision failed:', error);
    }
  }

  /**
   * Updates project patterns after successful operations.
   */
  async updateProjectPatterns(
    projectPath: string,
    pattern: string,
  ): Promise<void> {
    try {
      const knowledge = await this.loadProjectKnowledge(projectPath);
      if (!knowledge.architectureNotes.includes(pattern)) {
        knowledge.architectureNotes.push(pattern);
        if (knowledge.architectureNotes.length > MAX_ARCHITECTURE_NOTES) {
          knowledge.architectureNotes = knowledge.architectureNotes.slice(
            knowledge.architectureNotes.length - MAX_ARCHITECTURE_NOTES,
          );
        }
        knowledge.lastUpdated = Date.now();
        await this.saveProjectKnowledge(projectPath, knowledge);
      }
    } catch (error) {
      debugLogger.debug('KnowledgeBase: updateProjectPatterns failed:', error);
    }
  }

  /**
   * Adds a key file to the project knowledge.
   */
  async addProjectKeyFile(
    projectPath: string,
    filePath: string,
  ): Promise<void> {
    try {
      const knowledge = await this.loadProjectKnowledge(projectPath);
      if (!knowledge.keyFiles.includes(filePath)) {
        knowledge.keyFiles.push(filePath);
        if (knowledge.keyFiles.length > MAX_KEY_FILES) {
          knowledge.keyFiles = knowledge.keyFiles.slice(
            knowledge.keyFiles.length - MAX_KEY_FILES,
          );
        }
        knowledge.lastUpdated = Date.now();
        await this.saveProjectKnowledge(projectPath, knowledge);
      }
    } catch (error) {
      debugLogger.debug('KnowledgeBase: addProjectKeyFile failed:', error);
    }
  }

  /**
   * Records a common issue for a project.
   */
  async addProjectIssue(
    projectPath: string,
    issue: string,
  ): Promise<void> {
    try {
      const knowledge = await this.loadProjectKnowledge(projectPath);
      if (!knowledge.commonIssues.includes(issue)) {
        knowledge.commonIssues.push(issue);
        if (knowledge.commonIssues.length > MAX_COMMON_ISSUES) {
          knowledge.commonIssues = knowledge.commonIssues.slice(
            knowledge.commonIssues.length - MAX_COMMON_ISSUES,
          );
        }
        knowledge.lastUpdated = Date.now();
        await this.saveProjectKnowledge(projectPath, knowledge);
      }
    } catch (error) {
      debugLogger.debug('KnowledgeBase: addProjectIssue failed:', error);
    }
  }

  // -------------------------------------------------------------------------
  // Public API: Knowledge retrieval
  // -------------------------------------------------------------------------

  /**
   * Gets relevant knowledge for a prompt, combining user profile and
   * project-specific knowledge.
   */
  async getRelevantKnowledge(
    _userPrompt: string,
    projectPath: string,
  ): Promise<string> {
    try {
      const [profile, projectKnowledge, corrections] = await Promise.all([
        this.loadProfile(),
        this.loadProjectKnowledge(projectPath),
        this.loadRecentCorrections(10),
      ]);

      const sections: string[] = [];

      // User preferences
      if (profile.preferredLanguages.length > 0) {
        sections.push(
          `Preferred languages: ${profile.preferredLanguages.join(', ')}`,
        );
      }
      if (Object.keys(profile.codingStyle).length > 0) {
        const styleEntries = Object.entries(profile.codingStyle)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        sections.push(`Coding style: ${styleEntries}`);
      }
      if (profile.preferredTools.length > 0) {
        sections.push(
          `Preferred tools: ${profile.preferredTools.join(', ')}`,
        );
      }
      if (profile.communicationStyle) {
        sections.push(
          `Communication style: ${profile.communicationStyle}`,
        );
      }

      // Recent corrections
      if (corrections.length > 0) {
        const correctionLines = corrections.map((c) => {
          if (c.from && c.to) return `"${c.from}" -> "${c.to}"`;
          if (c.to) return `Use: ${c.to}`;
          if (c.from) return `Avoid: ${c.from}`;
          return c.raw;
        });
        sections.push(
          `Previous corrections:\n${correctionLines.map((l) => `  - ${l}`).join('\n')}`,
        );
      }

      // Project knowledge
      if (projectKnowledge.projectName) {
        if (projectKnowledge.buildCommand) {
          sections.push(`Build command: ${projectKnowledge.buildCommand}`);
        }
        if (projectKnowledge.testCommand) {
          sections.push(`Test command: ${projectKnowledge.testCommand}`);
        }
        if (projectKnowledge.architectureNotes.length > 0) {
          sections.push(
            `Architecture notes:\n${projectKnowledge.architectureNotes.map((n) => `  - ${n}`).join('\n')}`,
          );
        }
        if (projectKnowledge.commonIssues.length > 0) {
          sections.push(
            `Known issues:\n${projectKnowledge.commonIssues.map((i) => `  - ${i}`).join('\n')}`,
          );
        }
      }

      return sections.join('\n');
    } catch (error) {
      debugLogger.debug('KnowledgeBase: getRelevantKnowledge failed:', error);
      return '';
    }
  }

  /**
   * Formats knowledge for system prompt injection.
   * Returns a formatted string wrapped in <user_knowledge> tags.
   * Truncated to MAX_CONTEXT_BYTES.
   */
  async formatKnowledgeContext(projectPath?: string): Promise<string> {
    try {
      const knowledge = await this.getRelevantKnowledge(
        '',
        projectPath ?? process.cwd(),
      );

      if (!knowledge.trim()) return '';

      const wrapped = `<user_knowledge>\n${knowledge}\n</user_knowledge>`;
      return truncateToBytes(wrapped, MAX_CONTEXT_BYTES);
    } catch (error) {
      debugLogger.debug(
        'KnowledgeBase: formatKnowledgeContext failed:',
        error,
      );
      return '';
    }
  }

  /**
   * Fires extractLearnings without awaiting. Non-blocking.
   */
  fireAndForget(
    userMessage: string,
    modelResponse: string,
    toolResults: Array<{ tool: string; args: unknown; result: string }> = [],
  ): void {
    this.extractLearnings(userMessage, modelResponse, toolResults).catch(
      (error) => {
        debugLogger.debug(
          'KnowledgeBase: background extraction failed:',
          error,
        );
      },
    );
  }

  // -------------------------------------------------------------------------
  // Profile management
  // -------------------------------------------------------------------------

  /**
   * Loads the user profile from disk, with in-memory caching.
   */
  async loadProfile(): Promise<UserProfile> {
    const now = Date.now();
    if (this.profileCache && now - this.profileCacheAge < this.CACHE_TTL_MS) {
      return this.profileCache;
    }

    const filePath = path.join(getKnowledgeDir(), USER_PROFILE_FILE);
    const profile = await readJsonFile<UserProfile>(filePath, {
      preferredLanguages: [],
      codingStyle: {},
      preferredTools: [],
      communicationStyle: '',
      expertiseAreas: [],
      corrections: [],
      lastUpdated: 0,
    });

    this.profileCache = profile;
    this.profileCacheAge = now;
    return profile;
  }

  /**
   * Saves the user profile to disk and invalidates cache.
   */
  async saveProfile(profile: UserProfile): Promise<void> {
    profile.lastUpdated = Date.now();
    const filePath = path.join(getKnowledgeDir(), USER_PROFILE_FILE);
    await writeJsonFile(filePath, profile);
    this.profileCache = profile;
    this.profileCacheAge = Date.now();
  }

  // -------------------------------------------------------------------------
  // Project knowledge management
  // -------------------------------------------------------------------------

  /**
   * Loads knowledge for a specific project by path.
   */
  async loadProjectKnowledge(projectPath: string): Promise<ProjectKnowledge> {
    const hash = hashProjectPath(projectPath);
    const filePath = path.join(getProjectPatternsDir(), `${hash}.json`);
    return readJsonFile<ProjectKnowledge>(filePath, {
      projectName: path.basename(projectPath),
      projectPath,
      buildCommand: '',
      testCommand: '',
      keyFiles: [],
      architectureNotes: [],
      commonIssues: [],
      lastUpdated: 0,
    });
  }

  /**
   * Saves project knowledge and updates the project index.
   */
  async saveProjectKnowledge(
    projectPath: string,
    knowledge: ProjectKnowledge,
  ): Promise<void> {
    const hash = hashProjectPath(projectPath);
    const patternsDir = getProjectPatternsDir();
    const filePath = path.join(patternsDir, `${hash}.json`);
    await writeJsonFile(filePath, knowledge);

    // Update index
    const indexPath = path.join(patternsDir, PROJECT_INDEX_FILE);
    const index = await readJsonFile<ProjectIndex>(indexPath, {});
    const projectName = path.basename(projectPath);
    index[projectName] = hash;
    await writeJsonFile(indexPath, index);
  }

  // -------------------------------------------------------------------------
  // Corrections
  // -------------------------------------------------------------------------

  /**
   * Saves a correction to the append-only corrections file.
   */
  async saveCorrection(correction: Correction): Promise<void> {
    const filePath = path.join(getKnowledgeDir(), CORRECTIONS_FILE);
    await appendJsonlFile(filePath, correction);

    // Also update profile corrections (most recent wins)
    const profile = await this.loadProfile();
    profile.corrections.push({
      date: correction.date,
      from: correction.from,
      to: correction.to,
    });
    // Keep only recent corrections in profile
    if (profile.corrections.length > 20) {
      profile.corrections = profile.corrections.slice(
        profile.corrections.length - 20,
      );
    }
    await this.saveProfile(profile);

    // Prune old entries
    await pruneJsonlFile<Correction>(filePath, MAX_CORRECTIONS);

    debugLogger.debug(
      `KnowledgeBase: saved correction "${correction.from}" -> "${correction.to}"`,
    );
  }

  /**
   * Loads the most recent N corrections.
   */
  async loadRecentCorrections(count: number): Promise<Correction[]> {
    const filePath = path.join(getKnowledgeDir(), CORRECTIONS_FILE);
    const all = await readJsonlFile<Correction>(filePath);
    return all.slice(Math.max(0, all.length - count));
  }

  // -------------------------------------------------------------------------
  // Expertise tracking
  // -------------------------------------------------------------------------

  /**
   * Updates the expertise profile based on topics discussed.
   */
  async updateExpertise(userMessage: string): Promise<void> {
    // Lightweight keyword extraction: pick out technical terms
    const techTerms = this.extractTechTerms(userMessage);
    if (techTerms.length === 0) return;

    const filePath = path.join(getKnowledgeDir(), EXPERTISE_FILE);
    const expertise = await readJsonFile<Record<string, number>>(
      filePath,
      {},
    );

    for (const term of techTerms) {
      expertise[term] = (expertise[term] ?? 0) + 1;
    }

    // Prune terms with low counts and cap total
    const entries = Object.entries(expertise)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100);
    const pruned = Object.fromEntries(entries);

    await writeJsonFile(filePath, pruned);

    // Update profile expertise areas (top 10)
    const topAreas = entries.slice(0, 10).map(([term]) => term);
    const profile = await this.loadProfile();
    if (JSON.stringify(profile.expertiseAreas) !== JSON.stringify(topAreas)) {
      profile.expertiseAreas = topAreas;
      await this.saveProfile(profile);
    }
  }

  // -------------------------------------------------------------------------
  // Private: detection helpers
  // -------------------------------------------------------------------------

  /**
   * Detects "always/never" style preference directives and saves them.
   */
  private async detectAndSavePreferences(userMessage: string): Promise<void> {
    for (const pattern of PREFERENCE_PATTERNS) {
      const match = userMessage.match(pattern.regex);
      if (match) {
        const { key, value } = pattern.extract(match);
        const profile = await this.loadProfile();

        // Store as a coding style preference
        const prefKey = `${key}_${value.slice(0, 30).replace(/\s+/g, '_').toLowerCase()}`;
        profile.codingStyle[prefKey] = value;
        await this.saveProfile(profile);

        debugLogger.debug(
          `KnowledgeBase: saved preference ${key}: ${value}`,
        );
        break; // Only save first match
      }
    }
  }

  /**
   * Detects build/test commands from tool usage results.
   */
  private async detectCommandsFromTools(
    toolResults: Array<{ tool: string; args: unknown; result: string }>,
  ): Promise<void> {
    for (const tr of toolResults) {
      // Look for shell/run tool invocations that succeeded
      if (
        tr.tool === 'run_in_terminal' ||
        tr.tool === 'shell' ||
        tr.tool === 'execute_command'
      ) {
        const args = tr.args as Record<string, unknown>;
        const command = (args?.['command'] ?? args?.['cmd'] ?? '') as string;
        if (!command) continue;

        // Check if it's a build command
        const buildMatch = BUILD_COMMAND_PATTERNS.some((p) => p.test(command));
        const testMatch = TEST_COMMAND_PATTERNS.some((p) => p.test(command));

        if (buildMatch || testMatch) {
          const cwd = (args?.['cwd'] ?? process.cwd()) as string;
          const knowledge = await this.loadProjectKnowledge(cwd);

          if (buildMatch && !knowledge.buildCommand) {
            knowledge.buildCommand = command.slice(0, 200);
            knowledge.lastUpdated = Date.now();
            await this.saveProjectKnowledge(cwd, knowledge);
            debugLogger.debug(
              `KnowledgeBase: learned build command: ${command}`,
            );
          }

          if (testMatch && !knowledge.testCommand) {
            knowledge.testCommand = command.slice(0, 200);
            knowledge.lastUpdated = Date.now();
            await this.saveProjectKnowledge(cwd, knowledge);
            debugLogger.debug(
              `KnowledgeBase: learned test command: ${command}`,
            );
          }
        }
      }
    }
  }

  /**
   * Extracts technical terms from a message for expertise tracking.
   * Lightweight keyword matching, no LLM calls.
   */
  private extractTechTerms(message: string): string[] {
    const TECH_KEYWORDS = new Set([
      'react', 'angular', 'vue', 'svelte', 'nextjs', 'remix',
      'typescript', 'javascript', 'python', 'rust', 'go', 'java',
      'kotlin', 'swift', 'ruby', 'php', 'csharp', 'cpp',
      'docker', 'kubernetes', 'terraform', 'aws', 'gcp', 'azure',
      'postgres', 'mysql', 'mongodb', 'redis', 'elasticsearch',
      'graphql', 'rest', 'grpc', 'websocket',
      'webpack', 'vite', 'rollup', 'esbuild', 'turbopack',
      'jest', 'vitest', 'mocha', 'pytest', 'junit',
      'git', 'cicd', 'nginx', 'linux', 'macos',
      'node', 'deno', 'bun',
      'sql', 'nosql', 'api', 'microservices', 'monolith',
      'authentication', 'authorization', 'oauth', 'jwt',
      'distributed systems', 'caching', 'queue', 'pubsub',
      'machine learning', 'deep learning', 'llm', 'ai',
      'bazel', 'blaze', 'piper', 'borg', 'spanner', 'bigtable',
      'protobuf', 'grpc', 'flume', 'mapreduce',
    ]);

    const words = message
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1);

    const found = new Set<string>();
    for (const word of words) {
      if (TECH_KEYWORDS.has(word)) {
        found.add(word);
      }
    }

    // Also check two-word phrases
    for (let i = 0; i < words.length - 1; i++) {
      const phrase = `${words[i]} ${words[i + 1]}`;
      if (TECH_KEYWORDS.has(phrase)) {
        found.add(phrase);
      }
    }

    return Array.from(found);
  }

  // -------------------------------------------------------------------------
  // Auto-pruning
  // -------------------------------------------------------------------------

  /**
   * Prunes old entries from all knowledge stores.
   * Should be called periodically (e.g., at session start).
   */
  async pruneOldEntries(): Promise<void> {
    try {
      const correctionsPath = path.join(getKnowledgeDir(), CORRECTIONS_FILE);
      const decisionsPath = path.join(getKnowledgeDir(), DECISIONS_FILE);

      await Promise.all([
        pruneJsonlFile<Correction>(correctionsPath, MAX_CORRECTIONS),
        pruneJsonlFile<Decision>(decisionsPath, MAX_DECISIONS),
      ]);

      // Prune old project knowledge files
      await this.pruneOldProjects();

      debugLogger.debug('KnowledgeBase: pruning complete');
    } catch (error) {
      debugLogger.debug('KnowledgeBase: pruning failed:', error);
    }
  }

  /**
   * Removes project knowledge files older than PRUNE_AGE_DAYS.
   */
  private async pruneOldProjects(): Promise<void> {
    try {
      const patternsDir = getProjectPatternsDir();
      const files = await fs.readdir(patternsDir).catch(() => [] as string[]);
      const cutoff = Date.now() - PRUNE_AGE_DAYS * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.endsWith('.json') || file === PROJECT_INDEX_FILE) continue;

        const filePath = path.join(patternsDir, file);
        const knowledge = await readJsonFile<ProjectKnowledge>(filePath, {
          projectName: '',
          projectPath: '',
          buildCommand: '',
          testCommand: '',
          keyFiles: [],
          architectureNotes: [],
          commonIssues: [],
          lastUpdated: 0,
        });

        if (knowledge.lastUpdated > 0 && knowledge.lastUpdated < cutoff) {
          await fs.unlink(filePath).catch(() => {});
          debugLogger.debug(
            `KnowledgeBase: pruned old project: ${knowledge.projectName}`,
          );
        }
      }
    } catch {
      // Best effort
    }
  }
}
