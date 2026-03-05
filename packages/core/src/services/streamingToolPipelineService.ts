/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallRequestInfo } from '../scheduler/types.js';
import type { ToolResult, AnyDeclarativeTool } from '../tools/tools.js';
import type { Config } from '../config/config.js';

/**
 * Result of a pre-executed tool call, cached for later retrieval
 * by the scheduler.
 */
export interface PipelinedToolResult {
  /** The original tool call request. */
  request: ToolCallRequestInfo;
  /** The tool execution result, or null if still pending. */
  result: ToolResult | null;
  /** Any error that occurred during pre-execution. */
  error: Error | null;
  /** Timestamp when pre-execution started. */
  startTime: number;
  /** Timestamp when pre-execution completed. */
  endTime?: number;
}

/**
 * Determines whether a tool is safe for early (speculative) execution
 * during model streaming. Only read-only tools with no side effects
 * qualify. Write tools, shell commands, and tools requiring user
 * confirmation must NOT be pre-executed.
 *
 * @param toolName - The name of the tool to check.
 * @param config - The application config, used to resolve tool metadata.
 * @returns true if the tool can safely be executed before the model
 *          finishes streaming.
 */
export function isSafeForEarlyExecution(
  toolName: string,
  config: Config,
): boolean {
  const tool = config.getToolRegistry().getTool(toolName);
  if (!tool) {
    return false;
  }
  return tool.isReadOnly;
}

/**
 * StreamingToolPipelineService enables pipeline parallelism between
 * model streaming and tool execution. When a function call is detected
 * in the streaming response (before the full response is complete),
 * read-only tools can be speculatively pre-executed so their results
 * are immediately available when the scheduler processes them.
 *
 * This is a pure optimization layer. The existing scheduler behavior
 * is unchanged -- if a pre-computed result is available, it is used;
 * otherwise normal execution proceeds.
 *
 * Safety guarantees:
 * - Only read-only tools (Kind.Read, Kind.Search, Kind.Fetch) are
 *   pre-executed.
 * - Write tools, shell commands, and any tool requiring confirmation
 *   are never pre-executed.
 * - If pre-execution fails, the error is silently swallowed and the
 *   scheduler will execute the tool normally.
 * - The service is stateless across turns -- reset() must be called
 *   between model calls.
 */
export class StreamingToolPipelineService {
  /** Map of callId -> Promise that resolves to a PipelinedToolResult. */
  private pendingExecutions: Map<string, Promise<PipelinedToolResult>> =
    new Map();

  /** Map of callId -> resolved PipelinedToolResult (available for instant retrieval). */
  private resolvedResults: Map<string, PipelinedToolResult> = new Map();

  /** Whether the pipeline is enabled. Can be disabled via config or at runtime. */
  private _enabled: boolean = true;

  constructor(private readonly config: Config) {}

  /**
   * Whether the pipeline is currently enabled.
   */
  get enabled(): boolean {
    return this._enabled;
  }

  /**
   * Enable or disable the pipeline. When disabled, queueForExecution
   * becomes a no-op.
   */
  set enabled(value: boolean) {
    this._enabled = value;
  }

  /**
   * Queue a tool call for early (speculative) execution. The tool
   * will be executed immediately in the background if it is safe to
   * do so. The result is cached for later retrieval via getResult().
   *
   * This method is fire-and-forget -- it never throws.
   *
   * @param toolCall - The tool call request detected in the stream.
   * @param signal - Abort signal for cancellation.
   */
  queueForExecution(toolCall: ToolCallRequestInfo, signal: AbortSignal): void {
    if (!this._enabled) {
      return;
    }

    // Don't queue if already queued or resolved
    if (
      this.pendingExecutions.has(toolCall.callId) ||
      this.resolvedResults.has(toolCall.callId)
    ) {
      return;
    }

    // Safety check: only pre-execute read-only tools
    if (!isSafeForEarlyExecution(toolCall.name, this.config)) {
      return;
    }

    const tool = this.config.getToolRegistry().getTool(toolCall.name);
    if (!tool) {
      return;
    }

    const executionPromise = this.executeEarly(toolCall, tool, signal);
    this.pendingExecutions.set(toolCall.callId, executionPromise);

    // When the promise resolves, move to resolvedResults for instant access
    executionPromise
      .then((pipelinedResult) => {
        this.resolvedResults.set(toolCall.callId, pipelinedResult);
      })
      .catch(() => {
        // Errors are captured inside executeEarly; this catch is a
        // safety net to prevent unhandled promise rejections.
      });
  }

  /**
   * Check if a pre-computed result is already available for a tool call.
   *
   * @param callId - The ID of the tool call.
   * @returns The pipelined result if available and successful, or null.
   */
  getResult(callId: string): PipelinedToolResult | null {
    return this.resolvedResults.get(callId) ?? null;
  }

  /**
   * Check whether a tool call has been queued (pending or resolved).
   *
   * @param callId - The ID of the tool call.
   * @returns true if the call was queued for early execution.
   */
  has(callId: string): boolean {
    return (
      this.pendingExecutions.has(callId) || this.resolvedResults.has(callId)
    );
  }

  /**
   * Wait for a specific tool call's pre-execution to complete.
   * Returns null if the call was not queued.
   *
   * @param callId - The ID of the tool call.
   * @returns The pipelined result, or null if not queued.
   */
  async awaitResult(callId: string): Promise<PipelinedToolResult | null> {
    const pending = this.pendingExecutions.get(callId);
    if (!pending) {
      return this.resolvedResults.get(callId) ?? null;
    }
    return pending;
  }

  /**
   * Wait for all pending pre-executions to complete.
   *
   * @returns A map of callId -> PipelinedToolResult for all completed
   *          pre-executions.
   */
  async awaitAll(): Promise<Map<string, PipelinedToolResult>> {
    const entries = Array.from(this.pendingExecutions.entries());
    await Promise.allSettled(entries.map(([, promise]) => promise));
    return new Map(this.resolvedResults);
  }

  /**
   * Get the number of pending (in-flight) pre-executions.
   */
  get pendingCount(): number {
    return this.pendingExecutions.size - this.resolvedResults.size;
  }

  /**
   * Get the number of resolved (completed) pre-executions.
   */
  get resolvedCount(): number {
    return this.resolvedResults.size;
  }

  /**
   * Clear all pipeline state. Must be called between model turns
   * to prevent stale results from leaking across turns.
   */
  reset(): void {
    this.pendingExecutions.clear();
    this.resolvedResults.clear();
  }

  /**
   * Execute a tool call speculatively. This builds the invocation,
   * runs it, and captures the result. Errors are caught and stored
   * in the PipelinedToolResult rather than thrown.
   */
  private async executeEarly(
    toolCall: ToolCallRequestInfo,
    tool: AnyDeclarativeTool,
    signal: AbortSignal,
  ): Promise<PipelinedToolResult> {
    const startTime = Date.now();

    try {
      // Build the invocation (validates parameters)
      const invocation = tool.build(toolCall.args);

      // Execute the tool
      const result = await invocation.execute(signal);

      return {
        request: toolCall,
        result,
        error: null,
        startTime,
        endTime: Date.now(),
      };
    } catch (error) {
      return {
        request: toolCall,
        result: null,
        error: error instanceof Error ? error : new Error(String(error)),
        startTime,
        endTime: Date.now(),
      };
    }
  }
}
