/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { analyzeProject, generateGeminiMd } from './projectAnalyzerService.js';
import type { ProjectInfo } from './projectAnalyzerService.js';

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
  },
}));

describe('analyzeProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: nothing exists
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  it('detects a TypeScript + npm project', () => {
    const fileMap: Record<string, boolean> = {
      '/project/package.json': true,
      '/project/package-lock.json': true,
      '/project/tsconfig.json': true,
      '/project/src': true,
    };

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return fileMap[p.toString()] ?? false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (p.toString().endsWith('package.json')) {
        return JSON.stringify({
          name: 'my-ts-project',
          type: 'module',
          scripts: {
            build: 'tsc',
            test: 'vitest run',
            lint: 'eslint .',
          },
        });
      }
      return '';
    });

    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as fs.Stats);

    const result = analyzeProject('/project');

    expect(result.name).toBe('my-ts-project');
    expect(result.languages).toContain('TypeScript');
    expect(result.packageManager).toBe('npm');
    expect(result.moduleSystem).toBe('ESM');
    expect(result.buildCommand).toBe('tsc');
    expect(result.testCommand).toBe('vitest run');
    expect(result.sourceDir).toBe('src');
  });

  it('detects a Python project with pytest', () => {
    const fileMap: Record<string, boolean> = {
      '/project/pyproject.toml': true,
      '/project/src': true,
    };

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return fileMap[p.toString()] ?? false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (p.toString().endsWith('pyproject.toml')) {
        return `
[project]
name = "my-python-lib"

[tool.pytest.ini_options]
testpaths = ["tests"]

[tool.ruff]
line-length = 88
`;
      }
      return '';
    });

    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as fs.Stats);

    const result = analyzeProject('/project');

    expect(result.name).toBe('my-python-lib');
    expect(result.languages).toContain('Python');
    expect(result.testFramework).toBe('pytest');
    expect(result.testCommand).toBe('pytest');
    expect(result.linter).toBe('ruff');
    expect(result.lintCommand).toBe('ruff check .');
  });

  it('detects a Go project', () => {
    const fileMap: Record<string, boolean> = {
      '/project/go.mod': true,
      '/project/cmd': true,
      '/project/.golangci.yml': true,
    };

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return fileMap[p.toString()] ?? false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (p.toString().endsWith('go.mod')) {
        return 'module github.com/user/myapp\n\ngo 1.21\n';
      }
      return '';
    });

    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as fs.Stats);

    const result = analyzeProject('/project');

    expect(result.name).toBe('github.com/user/myapp');
    expect(result.languages).toContain('Go');
    expect(result.testFramework).toBe('go test');
    expect(result.testCommand).toBe('go test ./...');
    expect(result.buildCommand).toBe('go build ./...');
    expect(result.linter).toBe('golangci-lint');
  });

  it('detects a Rust project', () => {
    const fileMap: Record<string, boolean> = {
      '/project/Cargo.toml': true,
      '/project/src': true,
    };

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return fileMap[p.toString()] ?? false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (p.toString().endsWith('Cargo.toml')) {
        return '[package]\nname = "my-rust-app"\nversion = "0.1.0"\n';
      }
      return '';
    });

    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as fs.Stats);

    const result = analyzeProject('/project');

    expect(result.name).toBe('my-rust-app');
    expect(result.languages).toContain('Rust');
    expect(result.testFramework).toBe('cargo test');
    expect(result.buildCommand).toBe('cargo build');
    expect(result.linter).toBe('clippy');
  });

  it('detects a monorepo with pnpm workspaces', () => {
    const fileMap: Record<string, boolean> = {
      '/project/package.json': true,
      '/project/pnpm-lock.yaml': true,
      '/project/pnpm-workspace.yaml': true,
      '/project/tsconfig.json': true,
    };

    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return fileMap[p.toString()] ?? false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (p.toString().endsWith('package.json')) {
        return JSON.stringify({
          name: 'my-monorepo',
          scripts: { build: 'turbo build' },
        });
      }
      return '';
    });

    const result = analyzeProject('/project');

    expect(result.name).toBe('my-monorepo');
    expect(result.packageManager).toBe('pnpm');
    expect(result.isMonorepo).toBe(true);
  });

  it('falls back to directory name when no project config found', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = analyzeProject('/some/path/unknown-project');

    expect(result.name).toBe('unknown-project');
    expect(result.languages).toEqual([]);
    expect(result.packageManager).toBeNull();
    expect(result.buildCommand).toBeNull();
    expect(result.testCommand).toBeNull();
  });
});

describe('generateGeminiMd', () => {
  it('generates a complete GEMINI.md for a TypeScript project', () => {
    const info: ProjectInfo = {
      name: 'my-project',
      languages: ['TypeScript'],
      packageManager: 'npm',
      buildCommand: 'tsc',
      testCommand: 'npx vitest run',
      testFramework: 'vitest',
      lintCommand: 'npx eslint .',
      linter: 'eslint',
      formatter: 'prettier',
      moduleSystem: 'ESM',
      sourceDir: 'src',
      testPattern: 'src/**/*.test.ts',
      configFiles: ['package.json', 'tsconfig.json'],
      isMonorepo: false,
    };

    const md = generateGeminiMd(info);

    expect(md).toContain('# Project: my-project');
    expect(md).toContain('## Build & Test Commands');
    expect(md).toContain('- Build: `tsc`');
    expect(md).toContain('- Test: `npx vitest run`');
    expect(md).toContain('- Lint: `npx eslint .`');
    expect(md).toContain('## Code Style');
    expect(md).toContain('- Language: TypeScript');
    expect(md).toContain('- Module system: ESM');
    expect(md).toContain('- Linter: eslint');
    expect(md).toContain('- Formatter: prettier');
    expect(md).toContain('- Test framework: vitest');
    expect(md).toContain('## Project Structure');
    expect(md).toContain('- Source: src/');
    expect(md).toContain('- Tests: src/**/*.test.ts');
    expect(md).toContain('- Config: package.json, tsconfig.json');
  });

  it('omits empty sections', () => {
    const info: ProjectInfo = {
      name: 'bare-project',
      languages: [],
      packageManager: null,
      buildCommand: null,
      testCommand: null,
      testFramework: null,
      lintCommand: null,
      linter: null,
      formatter: null,
      moduleSystem: null,
      sourceDir: null,
      testPattern: null,
      configFiles: [],
      isMonorepo: false,
    };

    const md = generateGeminiMd(info);

    expect(md).toContain('# Project: bare-project');
    expect(md).not.toContain('## Build & Test Commands');
    expect(md).not.toContain('## Code Style');
    expect(md).not.toContain('## Project Structure');
  });

  it('includes monorepo layout indicator', () => {
    const info: ProjectInfo = {
      name: 'mono',
      languages: ['TypeScript'],
      packageManager: 'pnpm',
      buildCommand: 'turbo build',
      testCommand: null,
      testFramework: null,
      lintCommand: null,
      linter: null,
      formatter: null,
      moduleSystem: null,
      sourceDir: null,
      testPattern: null,
      configFiles: ['package.json'],
      isMonorepo: true,
    };

    const md = generateGeminiMd(info);

    expect(md).toContain('- Layout: monorepo');
  });
});
