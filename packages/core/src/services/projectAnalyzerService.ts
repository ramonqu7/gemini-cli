/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import * as path from 'node:path';

/** Detected project characteristics. */
export interface ProjectInfo {
  /** Project name (from package.json, go.mod, Cargo.toml, etc.) */
  name: string;
  /** Primary language(s) detected */
  languages: string[];
  /** Package manager / build tool (npm, yarn, pnpm, pip, cargo, go, bazel) */
  packageManager: string | null;
  /** Build command if detectable */
  buildCommand: string | null;
  /** Test command if detectable */
  testCommand: string | null;
  /** Test framework name (vitest, jest, pytest, go test, etc.) */
  testFramework: string | null;
  /** Lint command if detectable */
  lintCommand: string | null;
  /** Linter name (eslint, prettier, ruff, golangci-lint) */
  linter: string | null;
  /** Formatter name (prettier, black, gofmt) */
  formatter: string | null;
  /** Module system (ESM, CommonJS) - TypeScript/JavaScript only */
  moduleSystem: string | null;
  /** Source directory */
  sourceDir: string | null;
  /** Test file pattern */
  testPattern: string | null;
  /** Key configuration files found */
  configFiles: string[];
  /** Whether this is a monorepo */
  isMonorepo: boolean;
}

/**
 * Safely reads and parses a JSON file, returning null on failure.
 */
function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Safely reads a text file, returning null on failure.
 */
function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Checks whether a file exists at the given path.
 */
function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * Detects the package manager from lockfiles and config files.
 */
function detectPackageManager(
  projectDir: string,
): { manager: string; lockfile: string } | null {
  const lockfiles: Array<{ file: string; manager: string }> = [
    { file: 'pnpm-lock.yaml', manager: 'pnpm' },
    { file: 'yarn.lock', manager: 'yarn' },
    { file: 'bun.lockb', manager: 'bun' },
    { file: 'package-lock.json', manager: 'npm' },
  ];

  for (const { file, manager } of lockfiles) {
    if (fileExists(path.join(projectDir, file))) {
      return { manager, lockfile: file };
    }
  }

  // Fallback: package.json exists but no lockfile
  if (fileExists(path.join(projectDir, 'package.json'))) {
    return { manager: 'npm', lockfile: '' };
  }

  return null;
}

/**
 * Detects the primary language(s) of the project.
 */
function detectLanguages(projectDir: string): string[] {
  const languages: string[] = [];

  if (fileExists(path.join(projectDir, 'tsconfig.json'))) {
    languages.push('TypeScript');
  } else if (fileExists(path.join(projectDir, 'package.json'))) {
    languages.push('JavaScript');
  }

  if (
    fileExists(path.join(projectDir, 'pyproject.toml')) ||
    fileExists(path.join(projectDir, 'requirements.txt')) ||
    fileExists(path.join(projectDir, 'setup.py'))
  ) {
    languages.push('Python');
  }

  if (fileExists(path.join(projectDir, 'go.mod'))) {
    languages.push('Go');
  }

  if (fileExists(path.join(projectDir, 'Cargo.toml'))) {
    languages.push('Rust');
  }

  if (
    fileExists(path.join(projectDir, 'pom.xml')) ||
    fileExists(path.join(projectDir, 'build.gradle')) ||
    fileExists(path.join(projectDir, 'build.gradle.kts'))
  ) {
    languages.push('Java');
  }

  return languages;
}

/**
 * Extracts a script command from package.json scripts.
 */
function getPackageScript(
  packageJson: Record<string, unknown>,
  scriptName: string,
): string | null {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const scripts = packageJson['scripts'] as Record<string, string> | undefined;
  if (scripts && typeof scripts[scriptName] === 'string') {
    return scripts[scriptName];
  }
  return null;
}

/**
 * Detects the test framework and command.
 */
function detectTestSetup(
  projectDir: string,
  packageJson: Record<string, unknown> | null,
): { framework: string | null; command: string | null; pattern: string | null } {
  // Check for vitest
  if (
    fileExists(path.join(projectDir, 'vitest.config.ts')) ||
    fileExists(path.join(projectDir, 'vitest.config.js')) ||
    fileExists(path.join(projectDir, 'vitest.config.mts'))
  ) {
    return {
      framework: 'vitest',
      command: 'npx vitest run',
      pattern: 'src/**/*.test.ts',
    };
  }

  // Check for jest
  if (
    fileExists(path.join(projectDir, 'jest.config.js')) ||
    fileExists(path.join(projectDir, 'jest.config.ts')) ||
    fileExists(path.join(projectDir, 'jest.config.mjs'))
  ) {
    return {
      framework: 'jest',
      command: 'npx jest',
      pattern: '**/*.test.{js,ts}',
    };
  }

  // Check for pytest
  if (fileExists(path.join(projectDir, 'pytest.ini'))) {
    return {
      framework: 'pytest',
      command: 'pytest',
      pattern: 'tests/**/*.py',
    };
  }

  // Check pyproject.toml for pytest config
  if (fileExists(path.join(projectDir, 'pyproject.toml'))) {
    const content = readTextFile(path.join(projectDir, 'pyproject.toml'));
    if (content && content.includes('[tool.pytest')) {
      return {
        framework: 'pytest',
        command: 'pytest',
        pattern: 'tests/**/*.py',
      };
    }
  }

  // Check for go tests
  if (fileExists(path.join(projectDir, 'go.mod'))) {
    return {
      framework: 'go test',
      command: 'go test ./...',
      pattern: '*_test.go',
    };
  }

  // Check for cargo tests
  if (fileExists(path.join(projectDir, 'Cargo.toml'))) {
    return {
      framework: 'cargo test',
      command: 'cargo test',
      pattern: 'src/**/*.rs (inline #[test])',
    };
  }

  // Check package.json test script as fallback
  if (packageJson) {
    const testScript = getPackageScript(packageJson, 'test');
    if (testScript) {
      let framework: string | null = null;
      if (testScript.includes('vitest')) framework = 'vitest';
      else if (testScript.includes('jest')) framework = 'jest';
      else if (testScript.includes('mocha')) framework = 'mocha';

      return {
        framework,
        command: testScript,
        pattern: null,
      };
    }
  }

  return { framework: null, command: null, pattern: null };
}

/**
 * Detects the build command.
 */
function detectBuildCommand(
  projectDir: string,
  packageJson: Record<string, unknown> | null,
): string | null {
  // Check package.json build script
  if (packageJson) {
    const buildScript = getPackageScript(packageJson, 'build');
    if (buildScript) return buildScript;
  }

  // Check for Makefile
  if (fileExists(path.join(projectDir, 'Makefile'))) {
    return 'make';
  }

  // Check for tsconfig (tsc build)
  if (
    fileExists(path.join(projectDir, 'tsconfig.json')) &&
    !packageJson
  ) {
    return 'tsc';
  }

  // Go
  if (fileExists(path.join(projectDir, 'go.mod'))) {
    return 'go build ./...';
  }

  // Rust
  if (fileExists(path.join(projectDir, 'Cargo.toml'))) {
    return 'cargo build';
  }

  // Bazel/Blaze
  if (
    fileExists(path.join(projectDir, 'BUILD')) ||
    fileExists(path.join(projectDir, 'BUILD.bazel'))
  ) {
    return 'bazel build //...';
  }

  return null;
}

/**
 * Detects linting tools.
 */
function detectLinter(
  projectDir: string,
  packageJson: Record<string, unknown> | null,
): { linter: string | null; command: string | null } {
  // ESLint
  const eslintConfigs = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    '.eslintrc.js',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
    '.eslintrc',
  ];
  for (const config of eslintConfigs) {
    if (fileExists(path.join(projectDir, config))) {
      return { linter: 'eslint', command: 'npx eslint .' };
    }
  }

  // Ruff (Python)
  if (fileExists(path.join(projectDir, 'ruff.toml'))) {
    return { linter: 'ruff', command: 'ruff check .' };
  }
  if (fileExists(path.join(projectDir, 'pyproject.toml'))) {
    const content = readTextFile(path.join(projectDir, 'pyproject.toml'));
    if (content && content.includes('[tool.ruff')) {
      return { linter: 'ruff', command: 'ruff check .' };
    }
  }

  // golangci-lint
  if (
    fileExists(path.join(projectDir, '.golangci.yml')) ||
    fileExists(path.join(projectDir, '.golangci.yaml')) ||
    fileExists(path.join(projectDir, '.golangci.toml'))
  ) {
    return { linter: 'golangci-lint', command: 'golangci-lint run' };
  }

  // Clippy (Rust)
  if (fileExists(path.join(projectDir, 'Cargo.toml'))) {
    return { linter: 'clippy', command: 'cargo clippy' };
  }

  // Fallback: package.json lint script
  if (packageJson) {
    const lintScript = getPackageScript(packageJson, 'lint');
    if (lintScript) {
      let linter: string | null = null;
      if (lintScript.includes('eslint')) linter = 'eslint';
      else if (lintScript.includes('biome')) linter = 'biome';
      return { linter, command: lintScript };
    }
  }

  return { linter: null, command: null };
}

/**
 * Detects formatter.
 */
function detectFormatter(
  projectDir: string,
): { formatter: string | null } {
  const prettierConfigs = [
    '.prettierrc',
    '.prettierrc.js',
    '.prettierrc.json',
    '.prettierrc.yml',
    '.prettierrc.yaml',
    '.prettierrc.cjs',
    '.prettierrc.mjs',
    'prettier.config.js',
    'prettier.config.cjs',
    'prettier.config.mjs',
  ];
  for (const config of prettierConfigs) {
    if (fileExists(path.join(projectDir, config))) {
      return { formatter: 'prettier' };
    }
  }

  // Biome
  if (fileExists(path.join(projectDir, 'biome.json'))) {
    return { formatter: 'biome' };
  }

  // Black (Python)
  if (fileExists(path.join(projectDir, 'pyproject.toml'))) {
    const content = readTextFile(path.join(projectDir, 'pyproject.toml'));
    if (content && content.includes('[tool.black')) {
      return { formatter: 'black' };
    }
  }

  return { formatter: null };
}

/**
 * Detects the module system (ESM vs CommonJS) for JS/TS projects.
 */
function detectModuleSystem(
  packageJson: Record<string, unknown> | null,
  projectDir: string,
): string | null {
  if (packageJson) {
    if (packageJson['type'] === 'module') return 'ESM';
    if (packageJson['type'] === 'commonjs') return 'CommonJS';
  }

  // Check tsconfig for module setting
  if (fileExists(path.join(projectDir, 'tsconfig.json'))) {
    const tsconfig = readJsonFile(path.join(projectDir, 'tsconfig.json'));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    if (tsconfig) {
      const compilerOptions = tsconfig['compilerOptions'] as
        | Record<string, unknown>
        | undefined;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      if (compilerOptions) {
        const module = (compilerOptions['module'] as string)?.toLowerCase();
        if (
          module &&
          (module.startsWith('es') ||
            module === 'nodenext' ||
            module === 'node16')
        ) {
          return 'ESM';
        }
        if (module === 'commonjs') {
          return 'CommonJS';
        }
      }
    }
  }

  return null;
}

/**
 * Detects the source directory.
 */
function detectSourceDir(projectDir: string): string | null {
  const candidates = ['src', 'lib', 'app', 'source', 'pkg', 'cmd'];
  for (const dir of candidates) {
    const fullPath = path.join(projectDir, dir);
    if (fileExists(fullPath) && fs.statSync(fullPath).isDirectory()) {
      return dir;
    }
  }
  return null;
}

/**
 * Detects key configuration files present in the project.
 */
function detectConfigFiles(projectDir: string): string[] {
  const candidates = [
    'package.json',
    'tsconfig.json',
    'pyproject.toml',
    'requirements.txt',
    'go.mod',
    'Cargo.toml',
    'Makefile',
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.yaml',
    '.github/workflows',
    '.env.example',
    'BUILD',
    'BUILD.bazel',
    'WORKSPACE',
  ];

  return candidates.filter((f) => fileExists(path.join(projectDir, f)));
}

/**
 * Detects if the project is a monorepo.
 */
function detectMonorepo(
  projectDir: string,
  packageJson: Record<string, unknown> | null,
): boolean {
  // Check for workspace config
  if (packageJson) {
    if (packageJson['workspaces']) return true;
  }

  // Check for lerna
  if (fileExists(path.join(projectDir, 'lerna.json'))) return true;

  // Check for pnpm workspaces
  if (fileExists(path.join(projectDir, 'pnpm-workspace.yaml'))) return true;

  // Check for nx
  if (fileExists(path.join(projectDir, 'nx.json'))) return true;

  // Check for turborepo
  if (fileExists(path.join(projectDir, 'turbo.json'))) return true;

  return false;
}

/**
 * Extracts the project name from available config files.
 */
function detectProjectName(
  projectDir: string,
  packageJson: Record<string, unknown> | null,
): string {
  // package.json name
  if (packageJson && typeof packageJson['name'] === 'string') {
    return packageJson['name'];
  }

  // go.mod module name
  if (fileExists(path.join(projectDir, 'go.mod'))) {
    const content = readTextFile(path.join(projectDir, 'go.mod'));
    if (content) {
      const match = content.match(/^module\s+(.+)/m);
      if (match) return match[1].trim();
    }
  }

  // Cargo.toml name
  if (fileExists(path.join(projectDir, 'Cargo.toml'))) {
    const content = readTextFile(path.join(projectDir, 'Cargo.toml'));
    if (content) {
      const match = content.match(/^name\s*=\s*"(.+)"/m);
      if (match) return match[1];
    }
  }

  // pyproject.toml name
  if (fileExists(path.join(projectDir, 'pyproject.toml'))) {
    const content = readTextFile(path.join(projectDir, 'pyproject.toml'));
    if (content) {
      const match = content.match(/^name\s*=\s*"(.+)"/m);
      if (match) return match[1];
    }
  }

  // Fallback: directory name
  return path.basename(projectDir);
}

/**
 * Analyzes a project directory and returns detected characteristics.
 * All detection is file-existence and content-based (no command execution).
 */
export function analyzeProject(projectDir: string): ProjectInfo {
  const packageJsonPath = path.join(projectDir, 'package.json');
  const packageJson = fileExists(packageJsonPath)
    ? readJsonFile(packageJsonPath)
    : null;

  const name = detectProjectName(projectDir, packageJson);
  const languages = detectLanguages(projectDir);
  const pkgManager = detectPackageManager(projectDir);
  const testSetup = detectTestSetup(projectDir, packageJson);
  const buildCommand = detectBuildCommand(projectDir, packageJson);
  const lintSetup = detectLinter(projectDir, packageJson);
  const formatterSetup = detectFormatter(projectDir);
  const moduleSystem = detectModuleSystem(packageJson, projectDir);
  const sourceDir = detectSourceDir(projectDir);
  const configFiles = detectConfigFiles(projectDir);
  const isMonorepo = detectMonorepo(projectDir, packageJson);

  return {
    name,
    languages,
    packageManager: pkgManager?.manager ?? null,
    buildCommand,
    testCommand: testSetup.command,
    testFramework: testSetup.framework,
    lintCommand: lintSetup.command,
    linter: lintSetup.linter,
    formatter: formatterSetup.formatter,
    moduleSystem,
    sourceDir,
    testPattern: testSetup.pattern,
    configFiles,
    isMonorepo,
  };
}

/**
 * Generates GEMINI.md content from detected project info.
 */
export function generateGeminiMd(info: ProjectInfo): string {
  const sections: string[] = [];

  // Header
  sections.push(`# Project: ${info.name}`);

  // Build & Test Commands
  const commands: string[] = [];
  if (info.buildCommand) {
    commands.push(`- Build: \`${info.buildCommand}\``);
  }
  if (info.testCommand) {
    commands.push(`- Test: \`${info.testCommand}\``);
  }
  if (info.lintCommand) {
    commands.push(`- Lint: \`${info.lintCommand}\``);
  }

  if (commands.length > 0) {
    sections.push(`## Build & Test Commands\n${commands.join('\n')}`);
  }

  // Code Style
  const styleLines: string[] = [];
  if (info.languages.length > 0) {
    styleLines.push(`- Language: ${info.languages.join(', ')}`);
  }
  if (info.moduleSystem) {
    styleLines.push(`- Module system: ${info.moduleSystem}`);
  }
  if (info.linter) {
    styleLines.push(`- Linter: ${info.linter}`);
  }
  if (info.formatter) {
    styleLines.push(`- Formatter: ${info.formatter}`);
  }
  if (info.testFramework) {
    styleLines.push(`- Test framework: ${info.testFramework}`);
  }

  if (styleLines.length > 0) {
    sections.push(`## Code Style\n${styleLines.join('\n')}`);
  }

  // Project Structure
  const structureLines: string[] = [];
  if (info.sourceDir) {
    structureLines.push(`- Source: ${info.sourceDir}/`);
  }
  if (info.testPattern) {
    structureLines.push(`- Tests: ${info.testPattern}`);
  }
  if (info.configFiles.length > 0) {
    structureLines.push(`- Config: ${info.configFiles.join(', ')}`);
  }
  if (info.isMonorepo) {
    structureLines.push(`- Layout: monorepo`);
  }

  if (structureLines.length > 0) {
    sections.push(`## Project Structure\n${structureLines.join('\n')}`);
  }

  return sections.join('\n\n') + '\n';
}
