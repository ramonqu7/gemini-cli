/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * On-demand scoped repo-map service that creates lightweight AST summaries
 * of specific code areas using fast regex-based extraction.
 *
 * NEVER scans the full repo. Always scoped to <200 files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitIgnoreParser } from '../utils/gitIgnoreParser.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The kind of scope to scan. */
export type ScopeKind = 'directory' | 'file';

/** Describes the area of the codebase to map. */
export interface RepoMapScope {
  kind: ScopeKind;
  /** Absolute path to the target directory or file. */
  target: string;
}

/** A single extracted symbol. */
export interface ExtractedSymbol {
  name: string;
  kind: 'fn' | 'class' | 'type' | 'interface' | 'const' | 'var' | 'default';
}

/** Summary for one file. */
export interface FileSummary {
  /** Relative path from rootDir. */
  relativePath: string;
  symbols: ExtractedSymbol[];
  /** Display-friendly import basenames (e.g. "AuthMiddleware", "utils"). */
  imports: string[];
  /** Raw relative import specifiers for tree traversal (e.g. "./auth/middleware"). */
  rawImports: string[];
}

/** Complete scoped repo map. */
export interface RepoMap {
  scope: RepoMapScope;
  files: FileSummary[];
  generatedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum files to scan per scope. */
const MAX_FILES_DEFAULT = 200;

/** Cache TTL in milliseconds (10 minutes). */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Max import-tree depth for file scope. */
const MAX_IMPORT_DEPTH = 2;

/** Extensions we know how to extract symbols from. */
const SUPPORTED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
]);

// ---------------------------------------------------------------------------
// Regex patterns per language family
// ---------------------------------------------------------------------------

/** TypeScript / JavaScript export patterns. */
const TS_PATTERNS: Array<{ re: RegExp; kind: ExtractedSymbol['kind'] }> = [
  {
    re: /^export\s+(?:async\s+)?function\s+(\w+)/,
    kind: 'fn',
  },
  {
    re: /^export\s+class\s+(\w+)/,
    kind: 'class',
  },
  {
    re: /^export\s+const\s+(\w+)/,
    kind: 'const',
  },
  {
    re: /^export\s+(?:let|var)\s+(\w+)/,
    kind: 'var',
  },
  {
    re: /^export\s+type\s+(\w+)/,
    kind: 'type',
  },
  {
    re: /^export\s+interface\s+(\w+)/,
    kind: 'interface',
  },
  {
    re: /^export\s+default\b/,
    kind: 'default',
  },
];

/** Python patterns (top-level only: no leading whitespace). */
const PY_PATTERNS: Array<{ re: RegExp; kind: ExtractedSymbol['kind'] }> = [
  {
    re: /^def\s+(\w+)\s*\(/,
    kind: 'fn',
  },
  {
    re: /^class\s+(\w+)\s*[:(]/,
    kind: 'class',
  },
  {
    re: /^([A-Z_][A-Z_0-9]*)\s*=/,
    kind: 'const',
  },
];

/** Go patterns. */
const GO_PATTERNS: Array<{ re: RegExp; kind: ExtractedSymbol['kind'] }> = [
  {
    re: /^func\s+(?:\([^)]*\)\s+)?(\w+)/,
    kind: 'fn',
  },
  {
    re: /^type\s+(\w+)\s+struct\b/,
    kind: 'class',
  },
  {
    re: /^type\s+(\w+)\s+interface\b/,
    kind: 'interface',
  },
];

/** Import extraction patterns (returns the module specifier). */
const IMPORT_PATTERNS: RegExp[] = [
  // TS/JS: import ... from 'module'
  /from\s+['"]([^'"]+)['"]/,
  // TS/JS: import 'module'
  /^import\s+['"]([^'"]+)['"]/,
  // TS/JS: require('module')
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/,
  // Python: from module import ...
  /^from\s+(\S+)\s+import/,
  // Python: import module
  /^import\s+(\S+)/,
  // Go: "package/path"
  /^\s*"([^"]+)"\s*$/,
];

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  map: RepoMap;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class RepoMapService {
  private cache = new Map<string, CacheEntry>();

  /**
   * Build a scoped map for a specific directory or file.
   *
   * @param rootDir   The project root (used for .gitignore resolution).
   * @param scope     The area to scan.
   * @param maxFiles  Maximum number of files to include (default 200).
   */
  async buildScopedMap(
    rootDir: string,
    scope: RepoMapScope,
    maxFiles: number = MAX_FILES_DEFAULT,
  ): Promise<RepoMap> {
    const cacheKey = this.cacheKey(scope);

    // Return cached if still valid.
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.map;
    }

    const gitIgnore = new GitIgnoreParser(rootDir);
    const cap = Math.min(maxFiles, MAX_FILES_DEFAULT);

    let files: FileSummary[];
    if (scope.kind === 'directory') {
      files = await this.scanDirectory(rootDir, scope.target, gitIgnore, cap);
    } else {
      files = await this.scanFileImportTree(
        rootDir,
        scope.target,
        gitIgnore,
        cap,
      );
    }

    const map: RepoMap = {
      scope,
      files,
      generatedAt: Date.now(),
    };

    this.cache.set(cacheKey, {
      map,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return map;
  }

  /**
   * Truncate a repo map to fit within a token budget (approximate).
   * Uses ~4 chars per token as a rough estimate.
   */
  getCondensedMap(repoMap: RepoMap, maxTokenBudget: number): string {
    const maxChars = maxTokenBudget * 4;
    const lines: string[] = [];

    for (const file of repoMap.files) {
      const symbolParts = file.symbols.map((s) => {
        if (s.kind === 'default') return 'default(export)';
        return `${s.name}(${s.kind})`;
      });

      let line = `${file.relativePath}: ${symbolParts.join(', ')}`;

      if (file.imports.length > 0) {
        line += ` -> imports: ${file.imports.join(', ')}`;
      }

      lines.push(line);

      // Check budget after each line.
      const totalLength = lines.reduce((sum, l) => sum + l.length + 1, 0);
      if (totalLength > maxChars) {
        // Remove the line that pushed us over and add a truncation marker.
        lines.pop();
        lines.push(`... (${repoMap.files.length - lines.length} more files)`);
        break;
      }
    }

    return lines.join('\n');
  }

  /**
   * Invalidate cache for a specific directory path.
   */
  invalidateScope(dirPath: string): void {
    const absDir = path.resolve(dirPath);
    for (const [key] of this.cache) {
      if (key.includes(absDir)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Clear all cached maps.
   */
  reset(): void {
    this.cache.clear();
  }

  // -------------------------------------------------------------------------
  // Internal: directory scanning
  // -------------------------------------------------------------------------

  private async scanDirectory(
    rootDir: string,
    dirPath: string,
    gitIgnore: GitIgnoreParser,
    maxFiles: number,
  ): Promise<FileSummary[]> {
    const absDir = path.resolve(dirPath);
    if (!fs.existsSync(absDir)) return [];

    const collected: string[] = [];
    this.collectFiles(rootDir, absDir, gitIgnore, collected, maxFiles, 1);

    const summaries: FileSummary[] = [];
    for (const filePath of collected) {
      const summary = await this.extractFileSummary(rootDir, filePath);
      if (summary) {
        summaries.push(summary);
      }
    }

    return summaries;
  }

  /**
   * Recursively collect files in a directory, respecting .gitignore.
   * For directory scope: scan target dir + 1 level of sub-directories.
   */
  private collectFiles(
    rootDir: string,
    dir: string,
    gitIgnore: GitIgnoreParser,
    collected: string[],
    maxFiles: number,
    maxDepth: number,
    currentDepth: number = 0,
  ): void {
    if (collected.length >= maxFiles) return;
    if (currentDepth > maxDepth) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (collected.length >= maxFiles) return;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);

      if (gitIgnore.isIgnored(relativePath)) continue;

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }
        this.collectFiles(
          rootDir,
          fullPath,
          gitIgnore,
          collected,
          maxFiles,
          maxDepth,
          currentDepth + 1,
        );
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name))) {
        collected.push(fullPath);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal: file import tree scanning
  // -------------------------------------------------------------------------

  private async scanFileImportTree(
    rootDir: string,
    filePath: string,
    gitIgnore: GitIgnoreParser,
    maxFiles: number,
  ): Promise<FileSummary[]> {
    const absFile = path.resolve(filePath);
    if (!fs.existsSync(absFile)) return [];

    const visited = new Set<string>();
    const queue: Array<{ file: string; depth: number }> = [
      { file: absFile, depth: 0 },
    ];

    const summaries: FileSummary[] = [];

    while (queue.length > 0 && summaries.length < maxFiles) {
      const item = queue.shift()!;
      if (visited.has(item.file)) continue;
      visited.add(item.file);

      const relativePath = path.relative(rootDir, item.file);
      if (gitIgnore.isIgnored(relativePath)) continue;

      const summary = await this.extractFileSummary(rootDir, item.file);
      if (!summary) continue;

      summaries.push(summary);

      // Follow imports up to MAX_IMPORT_DEPTH using raw specifiers.
      if (item.depth < MAX_IMPORT_DEPTH) {
        for (const imp of summary.rawImports) {
          const resolved = this.resolveImportPath(item.file, imp);
          if (resolved && !visited.has(resolved)) {
            queue.push({ file: resolved, depth: item.depth + 1 });
          }
        }
      }
    }

    return summaries;
  }

  // -------------------------------------------------------------------------
  // Internal: symbol extraction
  // -------------------------------------------------------------------------

  private async extractFileSummary(
    rootDir: string,
    filePath: string,
  ): Promise<FileSummary | null> {
    const ext = path.extname(filePath);
    if (!SUPPORTED_EXTENSIONS.has(ext)) return null;

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    const lines = content.split('\n');
    const symbols: ExtractedSymbol[] = [];
    const imports: string[] = [];
    const rawImports: string[] = [];

    const patterns = this.getPatternsForExt(ext);

    for (const line of lines) {
      const trimmed = line.trimStart();

      // Extract symbols.
      for (const pat of patterns) {
        const match = trimmed.match(pat.re);
        if (match) {
          symbols.push({
            name: match[1] ?? 'default',
            kind: pat.kind,
          });
          break; // One symbol per line max.
        }
      }

      // Extract imports.
      for (const importRe of IMPORT_PATTERNS) {
        const match = trimmed.match(importRe);
        if (match && match[1]) {
          // Only keep relative imports (not from external packages).
          const spec = match[1];
          if (spec.startsWith('.') || spec.startsWith('/')) {
            // Store raw specifier for tree traversal.
            if (!rawImports.includes(spec)) {
              rawImports.push(spec);
            }
            // Normalize to just the basename for display.
            const basename = path.basename(spec).replace(/\.\w+$/, '');
            if (!imports.includes(basename)) {
              imports.push(basename);
            }
          }
          break;
        }
      }
    }

    if (symbols.length === 0 && imports.length === 0) return null;

    return {
      relativePath: path.relative(rootDir, filePath),
      symbols,
      imports,
      rawImports,
    };
  }

  private getPatternsForExt(
    ext: string,
  ): Array<{ re: RegExp; kind: ExtractedSymbol['kind'] }> {
    switch (ext) {
      case '.ts':
      case '.tsx':
      case '.js':
      case '.jsx':
      case '.mjs':
      case '.cjs':
        return TS_PATTERNS;
      case '.py':
        return PY_PATTERNS;
      case '.go':
        return GO_PATTERNS;
      default:
        return [];
    }
  }

  // -------------------------------------------------------------------------
  // Internal: import resolution
  // -------------------------------------------------------------------------

  /**
   * Best-effort resolution of a relative import specifier to an absolute path.
   * Tries common extensions if the specifier doesn't include one.
   */
  private resolveImportPath(
    fromFile: string,
    importSpec: string,
  ): string | null {
    if (!importSpec.startsWith('.') && !importSpec.startsWith('/')) {
      return null; // External package — skip.
    }

    const dir = path.dirname(fromFile);
    const base = path.resolve(dir, importSpec);

    // If it already has an extension, check directly.
    if (path.extname(base)) {
      return fs.existsSync(base) ? base : null;
    }

    // Try common extensions.
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go'];
    for (const ext of extensions) {
      const candidate = base + ext;
      if (fs.existsSync(candidate)) return candidate;
    }

    // Try index file in directory.
    for (const ext of extensions) {
      const candidate = path.join(base, `index${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Internal: caching
  // -------------------------------------------------------------------------

  private cacheKey(scope: RepoMapScope): string {
    return `${scope.kind}:${path.resolve(scope.target)}`;
  }
}
