/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import { describe, it, expect } from 'vitest';
import { parseLoopArgs } from './loopCommand.js';

describe('parseLoopArgs', () => {
  it('parses leading interval', () => {
    const result = parseLoopArgs('5m check the build');
    expect(result).toEqual({ interval: '5m', prompt: 'check the build' });
  });

  it('parses leading interval with hours', () => {
    const result = parseLoopArgs('2h run tests');
    expect(result).toEqual({ interval: '2h', prompt: 'run tests' });
  });

  it('parses trailing every clause', () => {
    const result = parseLoopArgs('check the build every 2h');
    expect(result).toEqual({ interval: '2h', prompt: 'check the build' });
  });

  it('parses trailing every clause with minutes', () => {
    const result = parseLoopArgs('run linter every 30m');
    expect(result).toEqual({ interval: '30m', prompt: 'run linter' });
  });

  it('defaults interval when none specified', () => {
    const result = parseLoopArgs('check the build');
    expect(result).toEqual({ interval: undefined, prompt: 'check the build' });
  });

  it('handles empty input', () => {
    const result = parseLoopArgs('');
    expect(result).toEqual({ interval: undefined, prompt: '' });
  });

  it('handles whitespace-only input', () => {
    const result = parseLoopArgs('   ');
    expect(result).toEqual({ interval: undefined, prompt: '' });
  });

  it('does not treat mid-string numbers as intervals', () => {
    const result = parseLoopArgs('check build 5 times');
    expect(result).toEqual({
      interval: undefined,
      prompt: 'check build 5 times',
    });
  });
});
