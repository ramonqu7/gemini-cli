/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  getToolGroupCounts,
  summarizeToolGroupActivity,
} from './toolGroupUtils.js';
import { CoreToolCallStatus } from '@google/gemini-cli-core';
import type { IndividualToolCallDisplay } from '../types.js';

function makeTool(
  name: string,
  status: CoreToolCallStatus = CoreToolCallStatus.Success,
): IndividualToolCallDisplay {
  return {
    callId: `call-${name}-${Math.random()}`,
    name,
    description: '',
    resultDisplay: undefined,
    status,
    confirmationDetails: undefined,
  };
}

describe('getToolGroupCounts', () => {
  it('counts running and completed tools', () => {
    const tools = [
      makeTool('ReadFile', CoreToolCallStatus.Success),
      makeTool('ReadFile', CoreToolCallStatus.Success),
      makeTool('Edit', CoreToolCallStatus.Executing),
    ];
    const counts = getToolGroupCounts(tools);
    expect(counts.running).toBe(1);
    expect(counts.completed).toBe(2);
    expect(counts.total).toBe(3);
  });

  it('counts errors', () => {
    const tools = [
      makeTool('Shell Command', CoreToolCallStatus.Error),
      makeTool('ReadFile', CoreToolCallStatus.Success),
    ];
    const counts = getToolGroupCounts(tools);
    expect(counts.errored).toBe(1);
    expect(counts.completed).toBe(1);
  });
});

describe('summarizeToolGroupActivity', () => {
  it('summarizes file reads', () => {
    const tools = [
      makeTool('ReadFile'),
      makeTool('ReadFile'),
      makeTool('ReadFile'),
    ];
    expect(summarizeToolGroupActivity(tools)).toBe('Read 3 files');
  });

  it('summarizes mixed operations', () => {
    const tools = [
      makeTool('ReadFile'),
      makeTool('ReadFile'),
      makeTool('Edit'),
      makeTool('Shell Command'),
      makeTool('Shell Command'),
    ];
    expect(summarizeToolGroupActivity(tools)).toBe(
      'Read 2 files, modified 1 file, ran 2 commands',
    );
  });

  it('summarizes search and reads', () => {
    const tools = [
      makeTool('FindFiles'),
      makeTool('ReadFile'),
      makeTool('ReadFile'),
      makeTool('ReadFile'),
      makeTool('ReadFile'),
      makeTool('ReadFile'),
    ];
    expect(summarizeToolGroupActivity(tools)).toBe(
      'Searched 1 pattern, read 5 files',
    );
  });

  it('returns empty for no tools', () => {
    expect(summarizeToolGroupActivity([])).toBe('');
  });

  it('handles single write', () => {
    const tools = [makeTool('WriteFile')];
    expect(summarizeToolGroupActivity(tools)).toBe('Modified 1 file');
  });

  it('handles grep tool', () => {
    const tools = [makeTool('grep_search'), makeTool('grep_search')];
    expect(summarizeToolGroupActivity(tools)).toBe('Searched 2 patterns');
  });

  it('categorizes unknown tools as other', () => {
    const tools = [makeTool('SomeCustomMcpTool'), makeTool('AnotherTool')];
    expect(summarizeToolGroupActivity(tools)).toBe('2 other tools');
  });

  it('handles batch tools', () => {
    const tools = [makeTool('BatchReadFiles'), makeTool('BatchShellCommands')];
    expect(summarizeToolGroupActivity(tools)).toBe(
      'Read 1 file, ran 1 command',
    );
  });
});
