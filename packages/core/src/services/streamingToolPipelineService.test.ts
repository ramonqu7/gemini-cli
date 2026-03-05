/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  StreamingToolPipelineService,
  isSafeForEarlyExecution,
} from './streamingToolPipelineService.js';
import type { ToolCallRequestInfo } from '../scheduler/types.js';
import type { Config } from '../config/config.js';
import { Kind } from '../tools/tools.js';

// Helper to create a mock tool with configurable Kind
function createMockTool(name: string, kind: Kind) {
  return {
    name,
    displayName: name,
    description: `Mock ${name}`,
    kind,
    get isReadOnly() {
      return kind === Kind.Read || kind === Kind.Search || kind === Kind.Fetch;
    },
    build: vi.fn().mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        llmContent: `result of ${name}`,
        returnDisplay: `result of ${name}`,
      }),
      shouldConfirmExecute: vi.fn().mockResolvedValue(false),
    }),
    canUpdateOutput: false,
    schema: {},
  };
}

// Helper to create a mock Config with a tool registry
function createMockConfig(
  tools: Map<string, ReturnType<typeof createMockTool>>,
): Config {
  return {
    getToolRegistry: () => ({
      getTool: (name: string) => tools.get(name) ?? null,
      getAllToolNames: () => Array.from(tools.keys()),
      getAllTools: () => Array.from(tools.values()),
    }),
  } as unknown as Config;
}

function createToolCallRequest(
  name: string,
  callId?: string,
): ToolCallRequestInfo {
  return {
    callId: callId ?? `${name}_${Date.now()}_0`,
    name,
    args: {},
    isClientInitiated: false,
    prompt_id: 'test-prompt',
  };
}

describe('StreamingToolPipelineService', () => {
  let service: StreamingToolPipelineService;
  let tools: Map<string, ReturnType<typeof createMockTool>>;
  let config: Config;
  let signal: AbortSignal;

  beforeEach(() => {
    tools = new Map([
      ['read_file', createMockTool('read_file', Kind.Read)],
      ['grep_search', createMockTool('grep_search', Kind.Search)],
      ['glob', createMockTool('glob', Kind.Search)],
      ['list_directory', createMockTool('list_directory', Kind.Read)],
      ['web_fetch', createMockTool('web_fetch', Kind.Fetch)],
      ['write_file', createMockTool('write_file', Kind.Edit)],
      ['edit', createMockTool('edit', Kind.Edit)],
      ['shell', createMockTool('shell', Kind.Execute)],
    ]);
    config = createMockConfig(tools);
    service = new StreamingToolPipelineService(config);
    signal = new AbortController().signal;
  });

  describe('isSafeForEarlyExecution', () => {
    it('should return true for read-only tools', () => {
      expect(isSafeForEarlyExecution('read_file', config)).toBe(true);
      expect(isSafeForEarlyExecution('grep_search', config)).toBe(true);
      expect(isSafeForEarlyExecution('glob', config)).toBe(true);
      expect(isSafeForEarlyExecution('list_directory', config)).toBe(true);
      expect(isSafeForEarlyExecution('web_fetch', config)).toBe(true);
    });

    it('should return false for write tools', () => {
      expect(isSafeForEarlyExecution('write_file', config)).toBe(false);
      expect(isSafeForEarlyExecution('edit', config)).toBe(false);
    });

    it('should return false for shell tools', () => {
      expect(isSafeForEarlyExecution('shell', config)).toBe(false);
    });

    it('should return false for unknown tools', () => {
      expect(isSafeForEarlyExecution('nonexistent_tool', config)).toBe(false);
    });
  });

  describe('queueForExecution', () => {
    it('should queue a read-only tool for early execution', async () => {
      const request = createToolCallRequest('read_file', 'call-1');
      service.queueForExecution(request, signal);

      expect(service.has('call-1')).toBe(true);
      expect(service.pendingCount).toBeGreaterThanOrEqual(0);

      // Wait for execution to complete
      const result = await service.awaitResult('call-1');
      expect(result).not.toBeNull();
      expect(result!.result).not.toBeNull();
      expect(result!.error).toBeNull();
    });

    it('should not queue write tools', () => {
      const request = createToolCallRequest('write_file', 'call-2');
      service.queueForExecution(request, signal);

      expect(service.has('call-2')).toBe(false);
    });

    it('should not queue shell tools', () => {
      const request = createToolCallRequest('shell', 'call-3');
      service.queueForExecution(request, signal);

      expect(service.has('call-3')).toBe(false);
    });

    it('should not queue unknown tools', () => {
      const request = createToolCallRequest('nonexistent', 'call-4');
      service.queueForExecution(request, signal);

      expect(service.has('call-4')).toBe(false);
    });

    it('should not double-queue the same call', async () => {
      const request = createToolCallRequest('read_file', 'call-5');
      service.queueForExecution(request, signal);
      service.queueForExecution(request, signal);

      await service.awaitAll();
      expect(service.resolvedCount).toBe(1);
    });

    it('should be a no-op when disabled', () => {
      service.enabled = false;
      const request = createToolCallRequest('read_file', 'call-6');
      service.queueForExecution(request, signal);

      expect(service.has('call-6')).toBe(false);
    });
  });

  describe('getResult', () => {
    it('should return null for un-queued calls', () => {
      expect(service.getResult('nonexistent')).toBeNull();
    });

    it('should return the result once execution completes', async () => {
      const request = createToolCallRequest('read_file', 'call-7');
      service.queueForExecution(request, signal);

      await service.awaitResult('call-7');
      const result = service.getResult('call-7');
      expect(result).not.toBeNull();
      expect(result!.result).not.toBeNull();
    });
  });

  describe('awaitAll', () => {
    it('should wait for all pending executions', async () => {
      service.queueForExecution(
        createToolCallRequest('read_file', 'call-a'),
        signal,
      );
      service.queueForExecution(
        createToolCallRequest('grep_search', 'call-b'),
        signal,
      );
      service.queueForExecution(
        createToolCallRequest('glob', 'call-c'),
        signal,
      );

      const results = await service.awaitAll();
      expect(results.size).toBe(3);
      expect(results.has('call-a')).toBe(true);
      expect(results.has('call-b')).toBe(true);
      expect(results.has('call-c')).toBe(true);
    });

    it('should return empty map when nothing queued', async () => {
      const results = await service.awaitAll();
      expect(results.size).toBe(0);
    });
  });

  describe('reset', () => {
    it('should clear all state', async () => {
      service.queueForExecution(
        createToolCallRequest('read_file', 'call-r1'),
        signal,
      );
      await service.awaitAll();

      expect(service.resolvedCount).toBe(1);

      service.reset();
      expect(service.resolvedCount).toBe(0);
      expect(service.pendingCount).toBe(0);
      expect(service.getResult('call-r1')).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should capture errors in the result rather than throwing', async () => {
      const failingTool = createMockTool('read_file', Kind.Read);
      failingTool.build = vi.fn().mockImplementation(() => {
        throw new Error('Build failed');
      });
      tools.set('read_file', failingTool);

      const request = createToolCallRequest('read_file', 'call-err');
      service.queueForExecution(request, signal);

      const result = await service.awaitResult('call-err');
      expect(result).not.toBeNull();
      expect(result!.error).not.toBeNull();
      expect(result!.error!.message).toBe('Build failed');
      expect(result!.result).toBeNull();
    });

    it('should capture execution errors', async () => {
      const failingTool = createMockTool('read_file', Kind.Read);
      failingTool.build = vi.fn().mockReturnValue({
        execute: vi.fn().mockRejectedValue(new Error('Execution failed')),
        shouldConfirmExecute: vi.fn().mockResolvedValue(false),
      });
      tools.set('read_file', failingTool);

      const request = createToolCallRequest('read_file', 'call-err2');
      service.queueForExecution(request, signal);

      const result = await service.awaitResult('call-err2');
      expect(result).not.toBeNull();
      expect(result!.error).not.toBeNull();
      expect(result!.error!.message).toBe('Execution failed');
      expect(result!.result).toBeNull();
    });
  });

  describe('enabled/disabled', () => {
    it('should default to enabled', () => {
      expect(service.enabled).toBe(true);
    });

    it('should allow toggling', () => {
      service.enabled = false;
      expect(service.enabled).toBe(false);
      service.enabled = true;
      expect(service.enabled).toBe(true);
    });
  });

  describe('awaitResult', () => {
    it('should return null for calls that were never queued', async () => {
      const result = await service.awaitResult('nonexistent');
      expect(result).toBeNull();
    });
  });
});
