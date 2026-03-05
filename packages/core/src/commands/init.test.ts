/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it, vi } from 'vitest';
import { performInit } from './init.js';

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    readdirSync: vi.fn().mockReturnValue([]),
    statSync: vi.fn().mockReturnValue({ isDirectory: () => false }),
  },
}));

describe('performInit', () => {
  it('returns info if GEMINI.md already exists', () => {
    const { action, generatedContent, projectInfo } = performInit(true);

    expect(action.type).toBe('message');
    if (action.type === 'message') {
      expect(action.messageType).toBe('info');
      expect(action.content).toContain('already exists');
    }
    expect(generatedContent).toBeNull();
    expect(projectInfo).toBeNull();
  });

  it('returns submit_prompt with LLM fallback if no targetDir provided', () => {
    const { action, generatedContent, projectInfo } = performInit(false);

    expect(action.type).toBe('submit_prompt');
    if (action.type === 'submit_prompt') {
      expect(action.content).toContain('You are an AI agent');
    }
    expect(generatedContent).toBeNull();
    expect(projectInfo).toBeNull();
  });

  it('returns submit_prompt with scaffold when targetDir is provided', () => {
    const { action, generatedContent, projectInfo } = performInit(
      false,
      '/some/project',
    );

    expect(action.type).toBe('submit_prompt');
    if (action.type === 'submit_prompt') {
      expect(action.content).toContain('You are an AI agent');
    }
    expect(projectInfo).not.toBeNull();
    expect(generatedContent).not.toBeNull();
    expect(projectInfo!.name).toBe('project');
  });
});
