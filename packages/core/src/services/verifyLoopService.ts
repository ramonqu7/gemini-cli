/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
} from '../tools/tool-names.js';

/**
 * Describes a detected test framework and its run command.
 */
export interface TestFrameworkInfo {
  /** Human-readable name (e.g., "vitest", "pytest", "cargo test") */
  name: string;
  /** The shell command to run the test suite */
  command: string;
}

/** File extensions considered source code (not config). */
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.go',
  '.rs',
  '.java', '.kt', '.kts',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp',
  '.rb',
  '.swift',
  '.dart',
  '.cs',
  '.php',
  '.scala',
  '.ex', '.exs',
  '.zig',
  '.lua',
  '.sh', '.bash',
]);

/** Patterns that indicate a file is a test file. */
const TEST_FILE_PATTERNS = [
  /\.test\./,
  /\.spec\./,
  /_test\./,
  /test_/,
  /\.tests\./,
  /\.specs\./,
  /\/__tests__\//,
  /\/tests?\//,
  /\.stories\./,
];

/** Tools that modify files. */
const FILE_MUTATION_TOOLS = new Set([
  WRITE_FILE_TOOL_NAME,
  EDIT_TOOL_NAME,
  'replace_in_file',
]);

/**
 * Stateless service that detects a project's test framework and provides
 * verify-loop prompt injection for the model after file edits.
 *
 * This service does NOT auto-run tests. It detects the right command and
 * injects it into the model's prompt so the model runs verification itself.
 */
export class VerifyLoopService {
  private projectRoot: string;
  private cachedFramework: TestFrameworkInfo | null | undefined = undefined;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  /**
   * Detects the test framework by checking for well-known config files
   * in the project root. Returns null if no framework is detected.
   *
   * Results are cached after first call.
   */
  detectTestFramework(): TestFrameworkInfo | null {
    if (this.cachedFramework !== undefined) {
      return this.cachedFramework;
    }
    this.cachedFramework = this.doDetect();
    return this.cachedFramework;
  }

  /**
   * Returns true when the given tool invocation is a file mutation on a
   * source file (not a config file, not a test file).
   */
  shouldVerify(
    toolName: string,
    args?: Record<string, unknown>,
  ): boolean {
    if (!FILE_MUTATION_TOOLS.has(toolName)) {
      return false;
    }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const filePath = args?.['file_path'] as string | undefined;
    if (!filePath) {
      return false;
    }

    return this.isSourceFile(filePath) && !this.isTestFile(filePath);
  }

  /**
   * Returns the detected test command, or null if no framework was found.
   */
  getVerifyCommand(): string | null {
    const fw = this.detectTestFramework();
    return fw?.command ?? null;
  }

  /**
   * Returns a prompt snippet instructing the model to run the project's
   * test suite. Returns empty string if no framework is detected.
   */
  formatVerifyPrompt(): string {
    const fw = this.detectTestFramework();
    if (!fw) {
      return '';
    }
    return (
      `\n- **Detected Test Framework (${fw.name}):** After modifying source files, ` +
      `run the test suite to verify your changes: \`${fw.command}\`. ` +
      `Do not claim success without passing tests.`
    );
  }

  // ── Private ──────────────────────────────────────────────────────

  private doDetect(): TestFrameworkInfo | null {
    // Order matters: more specific checks first.

    // Node.js / JavaScript / TypeScript
    const packageJsonPath = path.join(this.projectRoot, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          const testScript = pkg?.scripts?.test as string | undefined;
        if (testScript) {
          // Detect specific runners from the test script
          if (testScript.includes('vitest')) {
            return { name: 'vitest', command: 'npx vitest run' };
          }
          if (testScript.includes('jest')) {
            return { name: 'jest', command: 'npx jest' };
          }
          if (testScript.includes('mocha')) {
            return { name: 'mocha', command: 'npm test' };
          }
          // Generic npm test
          return { name: 'npm', command: 'npm test' };
        }
        // No test script but package.json exists — check for vitest/jest in devDeps
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const devDeps = pkg?.devDependencies ?? {};
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const deps = pkg?.dependencies ?? {};
        if (devDeps['vitest'] || deps['vitest']) {
          return { name: 'vitest', command: 'npx vitest run' };
        }
        if (devDeps['jest'] || deps['jest']) {
          return { name: 'jest', command: 'npx jest' };
        }
      } catch {
        // Malformed package.json — skip
      }
    }

    // Python
    if (
      fs.existsSync(path.join(this.projectRoot, 'pyproject.toml')) ||
      fs.existsSync(path.join(this.projectRoot, 'setup.py')) ||
      fs.existsSync(path.join(this.projectRoot, 'setup.cfg'))
    ) {
      return { name: 'pytest', command: 'pytest' };
    }

    // Go
    if (fs.existsSync(path.join(this.projectRoot, 'go.mod'))) {
      return { name: 'go test', command: 'go test ./...' };
    }

    // Rust
    if (fs.existsSync(path.join(this.projectRoot, 'Cargo.toml'))) {
      return { name: 'cargo test', command: 'cargo test' };
    }

    // Makefile with test target
    const makefilePath = path.join(this.projectRoot, 'Makefile');
    if (fs.existsSync(makefilePath)) {
      try {
        const content = fs.readFileSync(makefilePath, 'utf-8');
        if (/^test\s*:/m.test(content)) {
          return { name: 'make', command: 'make test' };
        }
      } catch {
        // Unreadable Makefile — skip
      }
    }

    // Bazel / Blaze (Google internal)
    if (
      fs.existsSync(path.join(this.projectRoot, 'BUILD')) ||
      fs.existsSync(path.join(this.projectRoot, 'BUILD.bazel'))
    ) {
      // Check for blaze (Google internal) vs bazel
      if (
        fs.existsSync(path.join(this.projectRoot, 'google3')) ||
        fs.existsSync('/google/bin/releases/build-system/live/blaze')
      ) {
        return { name: 'blaze', command: 'blaze test //...' };
      }
      return { name: 'bazel', command: 'bazel test //...' };
    }

    return null;
  }

  private isSourceFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return SOURCE_EXTENSIONS.has(ext);
  }

  private isTestFile(filePath: string): boolean {
    const basename = path.basename(filePath);
    return TEST_FILE_PATTERNS.some((pattern) => pattern.test(basename) || pattern.test(filePath));
  }
}
