/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Describes a detected linter/formatter and its commands.
 */
export interface LintConfig {
  /** Human-readable name (e.g., "eslint", "ruff", "gofmt") */
  name: string;
  /** Shell command to check and auto-fix a file */
  fixCommand: (filePath: string) => string;
  /** Shell command to check a file without fixing */
  checkCommand: (filePath: string) => string;
}

/**
 * Stateless service that detects a project's linter/formatter and provides
 * prompt injection for the model after file edits.
 *
 * This service does NOT auto-run linters. It detects the right commands and
 * injects them into the model's prompt so the model runs linting itself.
 */
export class LintService {
  private projectRoot: string;
  private cachedConfig: LintConfig | null | undefined = undefined;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  /**
   * Detects the linter/formatter by checking for well-known config files
   * in the project root. Returns null if no linter is detected.
   *
   * Results are cached after first call.
   */
  detectLinter(): LintConfig | null {
    if (this.cachedConfig !== undefined) {
      return this.cachedConfig;
    }
    this.cachedConfig = this.doDetect();
    return this.cachedConfig;
  }

  /**
   * Returns a prompt snippet instructing the model to run the project's
   * linter/formatter after editing files. Returns empty string if no
   * linter is detected.
   */
  formatLintPrompt(): string {
    const config = this.detectLinter();
    if (!config) {
      return '';
    }

    const exampleFix = config.fixCommand('<file>');
    const exampleCheck = config.checkCommand('<file>');

    return (
      `\n- **Linter Integration (${config.name}):** After editing source files, ` +
      `run the linter to fix auto-fixable issues: \`${exampleFix}\`. ` +
      `To check without fixing: \`${exampleCheck}\`. ` +
      `Fix auto-fixable issues. Report any remaining errors that require manual attention.`
    );
  }

  // ── Private ──────────────────────────────────────────────────────

  private doDetect(): LintConfig | null {
    // Piper workspace (Google internal) — use blaze build for compilation checks
    if (this.projectRoot.startsWith('/google/src/cloud/')) {
      return {
        name: 'blaze',
        fixCommand: (filePath: string) =>
          `blaze build ${this.blazeTarget(filePath)}`,
        checkCommand: (filePath: string) =>
          `blaze build ${this.blazeTarget(filePath)}`,
      };
    }

    // Node.js / JavaScript / TypeScript — check package.json for linters
    const packageJsonPath = path.join(this.projectRoot, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(
          fs.readFileSync(packageJsonPath, 'utf-8'),
        ) as Record<string, unknown>;
        const devDeps = (pkg?.['devDependencies'] ?? {}) as Record<
          string,
          unknown
        >;
        const deps = (pkg?.['dependencies'] ?? {}) as Record<string, unknown>;

        // Biome (newer, faster)
        if (devDeps['@biomejs/biome'] || deps['@biomejs/biome']) {
          return {
            name: 'biome',
            fixCommand: (filePath: string) =>
              `npx biome check --fix ${filePath}`,
            checkCommand: (filePath: string) =>
              `npx biome check ${filePath}`,
          };
        }

        // ESLint
        if (devDeps['eslint'] || deps['eslint']) {
          return {
            name: 'eslint',
            fixCommand: (filePath: string) =>
              `npx eslint --fix ${filePath}`,
            checkCommand: (filePath: string) => `npx eslint ${filePath}`,
          };
        }
      } catch {
        // Malformed package.json — skip
      }
    }

    // Python — ruff (modern) or pyproject.toml
    const pyprojectPath = path.join(this.projectRoot, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
      try {
        const content = fs.readFileSync(pyprojectPath, 'utf-8');
        if (content.includes('[tool.ruff]') || content.includes('ruff')) {
          return {
            name: 'ruff',
            fixCommand: (filePath: string) =>
              `ruff check --fix ${filePath}`,
            checkCommand: (filePath: string) =>
              `ruff check ${filePath}`,
          };
        }
      } catch {
        // Unreadable pyproject.toml — skip
      }
    }

    // Go — golangci-lint or gofmt
    if (
      fs.existsSync(path.join(this.projectRoot, '.golangci.yml')) ||
      fs.existsSync(path.join(this.projectRoot, '.golangci.yaml'))
    ) {
      return {
        name: 'golangci-lint',
        fixCommand: (_filePath: string) =>
          `golangci-lint run --fix ./...`,
        checkCommand: (_filePath: string) =>
          `golangci-lint run ./...`,
      };
    }

    if (fs.existsSync(path.join(this.projectRoot, 'go.mod'))) {
      return {
        name: 'gofmt',
        fixCommand: (filePath: string) => `gofmt -w ${filePath}`,
        checkCommand: (filePath: string) => `gofmt -l ${filePath}`,
      };
    }

    // Rust — cargo clippy
    if (fs.existsSync(path.join(this.projectRoot, 'Cargo.toml'))) {
      return {
        name: 'clippy',
        fixCommand: (_filePath: string) =>
          `cargo clippy --fix --allow-dirty`,
        checkCommand: (_filePath: string) =>
          `cargo clippy`,
      };
    }

    return null;
  }

  /**
   * Convert a file path to a rough blaze target for Google internal projects.
   * Falls back to //... if the path doesn't map cleanly.
   */
  private blazeTarget(filePath: string): string {
    const relative = path.relative(this.projectRoot, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return '//...';
    }
    const dir = path.dirname(relative);
    return `//${dir}/...`;
  }
}
