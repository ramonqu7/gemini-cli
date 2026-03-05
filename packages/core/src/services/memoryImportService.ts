/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { debugLogger } from '../utils/debugLogger.js';

const IMPORT_PATTERN =
  /@(~\/[^\s]+|\.\/[^\s]+|\/[^\s]+|[a-zA-Z][^\s]*\.(md|txt|json|yaml|yml|toml))/g;
const MAX_IMPORT_DEPTH = 5;
const MAX_IMPORT_SIZE = 50_000; // 50KB per imported file

/**
 * Resolves and inlines @import references in GEMINI.md content.
 *
 * Supports:
 * - @path/to/file.md - relative to the GEMINI.md file
 * - @~/path/to/file.md - relative to home directory
 * - @/absolute/path/to/file.md - absolute paths
 *
 * Example in GEMINI.md:
 * ```
 * See @README.md for project overview.
 * Personal prefs: @~/.gemini/my-project-prefs.md
 * ```
 */
export async function resolveImports(
  content: string,
  basePath: string,
  depth: number = 0,
  visited: Set<string> = new Set(),
): Promise<string> {
  if (depth >= MAX_IMPORT_DEPTH) {
    debugLogger.debug(`Import depth limit reached (${MAX_IMPORT_DEPTH})`);
    return content;
  }

  const imports: Array<{ match: string; filePath: string }> = [];
  let match: RegExpExecArray | null;
  const pattern = new RegExp(IMPORT_PATTERN.source, 'g');

  while ((match = pattern.exec(content)) !== null) {
    const importPath = match[1];
    let resolvedPath: string;

    if (importPath.startsWith('~/')) {
      resolvedPath = path.join(process.env['HOME'] || '~', importPath.slice(2));
    } else if (importPath.startsWith('/')) {
      resolvedPath = importPath;
    } else {
      resolvedPath = path.resolve(basePath, importPath);
    }

    imports.push({ match: match[0], filePath: resolvedPath });
  }

  if (imports.length === 0) return content;

  let result = content;

  for (const imp of imports) {
    const normalizedPath = path.resolve(imp.filePath);

    // Prevent circular imports
    if (visited.has(normalizedPath)) {
      debugLogger.debug(`Circular import detected: ${normalizedPath}`);
      continue;
    }

    try {
      const stat = await fs.stat(normalizedPath);
      if (stat.size > MAX_IMPORT_SIZE) {
        debugLogger.debug(
          `Import too large (${stat.size} bytes): ${normalizedPath}`,
        );
        result = result.replace(imp.match, `[Import too large: ${imp.match}]`);
        continue;
      }

      let importedContent = await fs.readFile(normalizedPath, 'utf-8');

      // Recursively resolve imports in the imported file
      const newVisited = new Set(visited);
      newVisited.add(normalizedPath);
      importedContent = await resolveImports(
        importedContent,
        path.dirname(normalizedPath),
        depth + 1,
        newVisited,
      );

      result = result.replace(imp.match, importedContent.trim());
    } catch {
      debugLogger.debug(`Failed to import: ${normalizedPath}`);
      // Leave the @reference as-is if file not found
    }
  }

  return result;
}

/**
 * Loads GEMINI.local.md from the project directory.
 * This file is for personal project-specific preferences
 * and should be added to .gitignore.
 */
export async function loadLocalMemory(
  projectDir: string,
): Promise<string | undefined> {
  const localPath = path.join(projectDir, 'GEMINI.local.md');
  try {
    const content = await fs.readFile(localPath, 'utf-8');
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loads user-level GEMINI.md from ~/.gemini/GEMINI.md
 */
export async function loadUserMemory(): Promise<string | undefined> {
  const homeDir = process.env['HOME'] || '~';
  const userPath = path.join(homeDir, '.gemini', 'GEMINI.md');
  try {
    const content = await fs.readFile(userPath, 'utf-8');
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loads scoped rules from .gemini/rules/*.md directory.
 * Each rule file is loaded and its content is prefixed with a header.
 */
export async function loadScopedRules(
  projectDir: string,
): Promise<string | undefined> {
  const rulesDir = path.join(projectDir, '.gemini', 'rules');
  try {
    const files = await fs.readdir(rulesDir);
    const mdFiles = files.filter((f) => f.endsWith('.md')).sort();

    if (mdFiles.length === 0) return undefined;

    const rules: string[] = [];
    for (const file of mdFiles) {
      const content = await fs.readFile(path.join(rulesDir, file), 'utf-8');
      if (content.trim()) {
        rules.push(`### Rule: ${file}\n${content.trim()}`);
      }
    }

    return rules.length > 0 ? rules.join('\n\n') : undefined;
  } catch {
    return undefined;
  }
}
