/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initCommand } from './initCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { CommandContext } from './types.js';
import type { SubmitPromptActionReturn } from '@google/gemini-cli-core';

// Mock the 'fs' module
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

// Mock performInit from core to control its return value
vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    performInit: vi.fn(),
  };
});

import { performInit } from '@google/gemini-cli-core';

describe('initCommand', () => {
  let mockContext: CommandContext;
  const targetDir = '/test/dir';
  const geminiMdPath = path.join(targetDir, 'GEMINI.md');

  beforeEach(() => {
    // Create a fresh mock context for each test
    mockContext = createMockCommandContext({
      services: {
        config: {
          getTargetDir: () => targetDir,
        },
      },
    });
  });

  afterEach(() => {
    // Clear all mocks after each test
    vi.clearAllMocks();
  });

  it('should inform the user if GEMINI.md already exists', async () => {
    // Arrange: Simulate that the file exists
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(performInit).mockReturnValue({
      action: {
        type: 'message',
        messageType: 'info',
        content:
          'A GEMINI.md file already exists in this directory. No changes were made.',
      },
      generatedContent: null,
      projectInfo: null,
    });

    // Act: Run the command's action
    const result = await initCommand.action!(mockContext, '');

    // Assert: Check for the correct informational message
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'A GEMINI.md file already exists in this directory. No changes were made.',
    });
    // Assert: Ensure no file was written
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('should create GEMINI.md with scaffold and submit a prompt', async () => {
    // Arrange: Simulate that the file does not exist
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(performInit).mockReturnValue({
      action: {
        type: 'submit_prompt',
        content: 'You are an AI agent that brings the power of Gemini...',
      },
      generatedContent: '# Project: test-project\n',
      projectInfo: {
        name: 'test-project',
        languages: ['TypeScript'],
        packageManager: 'npm',
        buildCommand: 'tsc',
        testCommand: 'vitest run',
        testFramework: 'vitest',
        lintCommand: 'eslint .',
        linter: 'eslint',
        formatter: 'prettier',
        moduleSystem: 'ESM',
        sourceDir: 'src',
        testPattern: 'src/**/*.test.ts',
        configFiles: ['package.json', 'tsconfig.json'],
        isMonorepo: false,
      },
    });

    // Act: Run the command's action
    const result = (await initCommand.action!(
      mockContext,
      '',
    )) as SubmitPromptActionReturn;

    // Assert: Check that writeFileSync was called with the scaffold content
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      geminiMdPath,
      '# Project: test-project\n',
      'utf8',
    );

    // Assert: Check that a detection summary was shown
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining('Detected:'),
      }),
      expect.any(Number),
    );

    // Assert: Check that the correct prompt is submitted
    expect(result.type).toBe('submit_prompt');
  });

  it('should show fallback message when no project info detected', async () => {
    // Arrange: No scaffold generated
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(performInit).mockReturnValue({
      action: {
        type: 'submit_prompt',
        content: 'You are an AI agent that brings the power of Gemini...',
      },
      generatedContent: null,
      projectInfo: null,
    });

    // Act
    await initCommand.action!(mockContext, '');

    // Assert: Fallback message shown
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: 'info',
        text: 'Empty GEMINI.md created. Now analyzing the project to populate it.',
      },
      expect.any(Number),
    );
  });

  it('should return an error if config is not available', async () => {
    // Arrange: Create a context without config
    const noConfigContext = createMockCommandContext();
    if (noConfigContext.services) {
      noConfigContext.services.config = null;
    }

    // Act: Run the command's action
    const result = await initCommand.action!(noConfigContext, '');

    // Assert: Check for the correct error message
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Configuration not available.',
    });
  });
});
