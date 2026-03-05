/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import path from 'node:path';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import type { Config } from '../config/config.js';
import {
  BATCH_READ_FILES_TOOL_NAME,
  BATCH_READ_FILES_DISPLAY_NAME,
} from './tool-names.js';
import { BATCH_READ_FILES_DEFINITION } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';
import { processSingleFileContent } from '../utils/fileUtils.js';

/**
 * Parameters for the BatchReadFiles tool
 */
export interface BatchReadFilesToolParams {
  /**
   * Array of file paths to read simultaneously
   */
  file_paths: string[];
}

interface SingleFileResult {
  filePath: string;
  content: string;
  error?: string;
}

class BatchReadFilesToolInvocation extends BaseToolInvocation<
  BatchReadFilesToolParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: BatchReadFilesToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    return `Reading ${this.params.file_paths.length} files`;
  }

  async execute(): Promise<ToolResult> {
    const results = await Promise.allSettled(
      this.params.file_paths.map((filePath) =>
        this.readSingleFile(filePath),
      ),
    );

    const fileResults: SingleFileResult[] = results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      return {
        filePath: this.params.file_paths[index],
        content: '',
        error: result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
      };
    });

    const parts: string[] = [];
    let hasErrors = false;

    for (const fileResult of fileResults) {
      if (fileResult.error) {
        parts.push(`=== ${fileResult.filePath} === ERROR: ${fileResult.error}`);
        hasErrors = true;
      } else {
        parts.push(`=== ${fileResult.filePath} ===\n${fileResult.content}`);
      }
    }

    const llmContent = parts.join('\n\n');
    const successCount = fileResults.filter((r) => !r.error).length;
    const errorCount = fileResults.filter((r) => r.error).length;

    let returnDisplay = `Read ${successCount} file(s)`;
    if (errorCount > 0) {
      returnDisplay += `, ${errorCount} failed`;
    }

    return {
      llmContent,
      returnDisplay,
      ...(hasErrors
        ? {
            error: {
              message: `${errorCount} file(s) could not be read`,
              type: undefined,
            },
          }
        : {}),
    };
  }

  private async readSingleFile(filePath: string): Promise<SingleFileResult> {
    const resolvedPath = path.resolve(
      this.config.getTargetDir(),
      filePath,
    );

    const validationError = this.config.validatePathAccess(
      resolvedPath,
      'read',
    );
    if (validationError) {
      return { filePath, content: '', error: validationError };
    }

    const result = await processSingleFileContent(
      resolvedPath,
      this.config.getTargetDir(),
      this.config.getFileSystemService(),
    );

    if (result.error) {
      return {
        filePath,
        content: '',
        error: result.error,
      };
    }

    let content: string;
    if (result.isTruncated) {
      const [start, end] = result.linesShown!;
      const total = result.originalLineCount!;
      content = `[Truncated: showing lines ${start}-${end} of ${total}]\n${typeof result.llmContent === 'string' ? result.llmContent : ''}`;
    } else {
      content =
        typeof result.llmContent === 'string' ? result.llmContent : '';
    }

    return { filePath, content };
  }
}

/**
 * Implementation of the BatchReadFiles tool
 */
export class BatchReadFilesTool extends BaseDeclarativeTool<
  BatchReadFilesToolParams,
  ToolResult
> {
  static readonly Name = BATCH_READ_FILES_TOOL_NAME;

  constructor(
    private config: Config,
    messageBus: MessageBus,
  ) {
    super(
      BatchReadFilesTool.Name,
      BATCH_READ_FILES_DISPLAY_NAME,
      BATCH_READ_FILES_DEFINITION.base.description!,
      Kind.Read,
      BATCH_READ_FILES_DEFINITION.base.parametersJsonSchema,
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(
    params: BatchReadFilesToolParams,
  ): string | null {
    if (!params.file_paths || !Array.isArray(params.file_paths)) {
      return "The 'file_paths' parameter must be an array of strings.";
    }

    if (params.file_paths.length === 0) {
      return "The 'file_paths' array must not be empty.";
    }

    if (params.file_paths.length > 10) {
      return 'Maximum of 10 file paths allowed per batch read.';
    }

    for (const filePath of params.file_paths) {
      if (typeof filePath !== 'string' || filePath.trim() === '') {
        return 'Each file path must be a non-empty string.';
      }
    }

    return null;
  }

  protected createInvocation(
    params: BatchReadFilesToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<BatchReadFilesToolParams, ToolResult> {
    return new BatchReadFilesToolInvocation(
      this.config,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }

  override getSchema(modelId?: string) {
    return resolveToolDeclaration(BATCH_READ_FILES_DEFINITION, modelId);
  }
}
