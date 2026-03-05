/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SHELL_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  READ_MANY_FILES_TOOL_NAME,
  LS_TOOL_NAME,
} from '../tools/tool-names.js';

/**
 * Result of formatting/truncating a tool output.
 */
export interface FormattedOutput {
  /** The (possibly truncated) content string. */
  content: string;
  /** Whether the output was truncated. */
  wasTruncated: boolean;
  /** Character count of the original output. */
  originalLength: number;
  /** Human-readable summary of what was truncated, e.g. "25 files matched, showing first 10". */
  summary?: string;
}

// Default limits — these are character counts, not token counts.
// Token-based thresholds are handled upstream in ToolExecutor.
const DEFAULT_MAX_OUTPUT_LINES = 200;
const DEFAULT_MAX_OUTPUT_CHARS = 50000;

// Per-strategy constants
const SHELL_HEAD_LINES = 50;
const SHELL_TAIL_LINES = 50;
const GREP_MAX_FILES = 15;
const GLOB_MAX_PATHS = 30;
const READ_FILE_HEAD_LINES = 100;
const READ_FILE_TAIL_LINES = 50;
const GENERIC_HEAD_LINES = 150;

/**
 * Intelligent tool output formatter that preserves the most useful information
 * when truncation is necessary, rather than doing a naive character-based cut.
 *
 * Per-tool strategies:
 *
 * **Shell**: Always preserves exit code, stderr, and signal information at the top.
 *   Shows first N + last N lines of stdout with a truncation marker in the middle.
 *
 * **Grep/ripgrep**: Shows the first N file groups with their matches, appends a
 *   summary of how many additional files had matches.
 *
 * **Glob**: Shows the first N file paths (already sorted by mtime by the tool),
 *   appends the total count.
 *
 * **File read**: Shows first N + last M lines with a truncation marker, preserving
 *   the file header metadata.
 *
 * **Generic**: Shows the first N lines with a total line count.
 *
 * Errors are never truncated — if the output contains an error section it is always
 * preserved in full.
 */
export class ToolOutputFormatterService {
  private readonly maxOutputLines: number;
  private readonly maxOutputChars: number;

  constructor(options?: { maxOutputLines?: number; maxOutputChars?: number }) {
    this.maxOutputLines = options?.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES;
    this.maxOutputChars = options?.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  }

  /**
   * Format tool output based on the tool type. If the output is within limits,
   * it is returned unchanged.
   */
  formatOutput(
    toolName: string,
    rawOutput: string,
    _args?: Record<string, unknown>,
  ): FormattedOutput {
    const originalLength = rawOutput.length;
    const withinGlobalLimits =
      rawOutput.length <= this.maxOutputChars &&
      countLines(rawOutput) <= this.maxOutputLines;

    // Dispatch to the appropriate per-tool strategy.
    // Per-tool strategies (grep, glob) have their own tighter limits
    // (e.g. max files shown) so they run even when global limits are not
    // exceeded. Strategies that only use the global limits (shell, read_file,
    // generic) short-circuit when output is within those limits.
    switch (toolName) {
      case SHELL_TOOL_NAME:
        if (withinGlobalLimits)
          return { content: rawOutput, wasTruncated: false, originalLength };
        return this.formatShellOutput(rawOutput, originalLength);
      case GREP_TOOL_NAME:
        return this.formatGrepOutput(rawOutput, originalLength);
      case GLOB_TOOL_NAME:
      case LS_TOOL_NAME:
        return this.formatGlobOutput(rawOutput, originalLength);
      case READ_FILE_TOOL_NAME:
      case READ_MANY_FILES_TOOL_NAME:
        if (withinGlobalLimits)
          return { content: rawOutput, wasTruncated: false, originalLength };
        return this.formatReadFileOutput(rawOutput, originalLength);
      default:
        if (withinGlobalLimits)
          return { content: rawOutput, wasTruncated: false, originalLength };
        return this.formatGenericOutput(rawOutput, originalLength);
    }
  }

  // ---------------------------------------------------------------------------
  //  Shell output
  // ---------------------------------------------------------------------------

  private formatShellOutput(
    raw: string,
    originalLength: number,
  ): FormattedOutput {
    // The shell tool structures output as sections separated by newlines:
    //   Output: ...
    //   Error: ...
    //   Exit Code: N
    //   Signal: ...
    //   Background PIDs: ...
    //   Process Group PGID: ...
    //
    // Strategy: always keep Error/Exit Code/Signal sections verbatim.
    // Truncate only the "Output:" section using head+tail.

    const sectionRegex =
      /^(Output|Error|Exit Code|Signal|Background PIDs|Process Group PGID): /m;
    const sections = raw.split(sectionRegex);

    // If the output doesn't follow the expected format, fall back to generic.
    if (sections.length < 3) {
      return this.formatShellRawFallback(raw, originalLength);
    }

    const resultParts: string[] = [];
    let truncatedOutputLines = 0;

    // sections[0] may be a preamble before the first recognized section header.
    if (sections[0].trim()) {
      resultParts.push(sections[0].trimEnd());
    }

    for (let i = 1; i < sections.length; i += 2) {
      const name = sections[i]; // e.g. "Output", "Error", "Exit Code"
      const body = sections[i + 1] ?? '';

      if (name === 'Output') {
        // Truncate the output body using head + tail.
        const lines = body.split('\n');
        if (lines.length > SHELL_HEAD_LINES + SHELL_TAIL_LINES) {
          const head = lines.slice(0, SHELL_HEAD_LINES);
          const tail = lines.slice(-SHELL_TAIL_LINES);
          truncatedOutputLines =
            lines.length - SHELL_HEAD_LINES - SHELL_TAIL_LINES;
          resultParts.push(
            `Output: ${head.join('\n')}\n\n... (${truncatedOutputLines} lines truncated) ...\n\n${tail.join('\n')}`,
          );
        } else {
          resultParts.push(`Output: ${body}`);
        }
      } else {
        // High-signal sections (Error, Exit Code, Signal, etc.) — keep in full.
        resultParts.push(`${name}: ${body}`);
      }
    }

    const content = resultParts.join('\n');
    const wasTruncated = truncatedOutputLines > 0;
    return {
      content,
      wasTruncated,
      originalLength,
      summary: wasTruncated
        ? `Shell output truncated: ${truncatedOutputLines} lines omitted from middle of stdout`
        : undefined,
    };
  }

  /**
   * Fallback for shell output that doesn't match the expected section format.
   * Preserves lines that look like exit codes or errors at the end.
   */
  private formatShellRawFallback(
    raw: string,
    originalLength: number,
  ): FormattedOutput {
    const lines = raw.split('\n');
    if (lines.length <= SHELL_HEAD_LINES + SHELL_TAIL_LINES) {
      // Small enough, just return it (we only got here due to char count).
      return this.formatGenericOutput(raw, originalLength);
    }

    // Pull out any trailing lines that contain exit code / error markers.
    const tailMarkers = /^(Exit Code|Error|Signal|exit status|FAIL|PASS)[:= ]/i;
    let metadataStart = lines.length;
    for (let i = lines.length - 1; i >= lines.length - 10 && i >= 0; i--) {
      if (tailMarkers.test(lines[i].trim())) {
        metadataStart = i;
      }
    }

    const metadataLines = lines.slice(metadataStart);
    const contentLines = lines.slice(0, metadataStart);

    const head = contentLines.slice(0, SHELL_HEAD_LINES);
    const tail = contentLines.slice(-SHELL_TAIL_LINES);
    const omitted =
      contentLines.length - SHELL_HEAD_LINES - SHELL_TAIL_LINES;

    const parts = [
      head.join('\n'),
      `\n... (${omitted} lines truncated) ...\n`,
      tail.join('\n'),
    ];
    if (metadataLines.length > 0) {
      parts.push('\n' + metadataLines.join('\n'));
    }

    return {
      content: parts.join('\n'),
      wasTruncated: true,
      originalLength,
      summary: `Shell output truncated: ${omitted} lines omitted from middle`,
    };
  }

  // ---------------------------------------------------------------------------
  //  Grep output
  // ---------------------------------------------------------------------------

  private formatGrepOutput(
    raw: string,
    originalLength: number,
  ): FormattedOutput {
    // Grep output format from grep-utils.ts:
    //   Found N match(es) for pattern "..." in path "...":
    //   ---
    //   File: path/to/file.ts
    //   L42: matched line
    //   ---
    //   File: path/to/other.ts
    //   ...

    const lines = raw.split('\n');

    // Find the header line (before the first ---)
    const firstSepIdx = lines.indexOf('---');
    if (firstSepIdx < 0) {
      // Doesn't look like grep output, use generic.
      return this.formatGenericOutput(raw, originalLength);
    }

    const headerLines = lines.slice(0, firstSepIdx + 1); // include first ---

    // Split remaining content into file groups separated by ---
    const rest = lines.slice(firstSepIdx + 1);
    const fileGroups: string[][] = [];
    let currentGroup: string[] = [];
    for (const line of rest) {
      if (line === '---') {
        if (currentGroup.length > 0) {
          fileGroups.push(currentGroup);
          currentGroup = [];
        }
      } else {
        currentGroup.push(line);
      }
    }
    if (currentGroup.length > 0) {
      fileGroups.push(currentGroup);
    }

    const totalFiles = fileGroups.length;
    if (totalFiles <= GREP_MAX_FILES) {
      // All file groups fit — no truncation needed despite char/line overflow.
      // This can happen with very large matched lines; just use generic truncation.
      return this.formatGenericOutput(raw, originalLength);
    }

    const keptGroups = fileGroups.slice(0, GREP_MAX_FILES);
    const omittedFiles = totalFiles - GREP_MAX_FILES;

    const resultLines = [
      ...headerLines,
      ...keptGroups.flatMap((group) => [...group, '---']),
      `\n... and ${omittedFiles} more file(s) with matches (${totalFiles} files total)`,
    ];

    const content = resultLines.join('\n');
    return {
      content,
      wasTruncated: true,
      originalLength,
      summary: `Grep results truncated: showing ${GREP_MAX_FILES} of ${totalFiles} files with matches`,
    };
  }

  // ---------------------------------------------------------------------------
  //  Glob output
  // ---------------------------------------------------------------------------

  private formatGlobOutput(
    raw: string,
    originalLength: number,
  ): FormattedOutput {
    // Glob output format from glob.ts:
    //   Found N file(s) matching "pattern" within ..., sorted by modification time (newest first):
    //   /path/to/file1
    //   /path/to/file2
    //   ...

    const lines = raw.split('\n');

    // The first line is the header/summary, the rest are file paths.
    const headerLine = lines[0];
    const pathLines = lines.slice(1).filter((l) => l.trim().length > 0);

    if (pathLines.length <= GLOB_MAX_PATHS) {
      return this.formatGenericOutput(raw, originalLength);
    }

    const keptPaths = pathLines.slice(0, GLOB_MAX_PATHS);
    const totalPaths = pathLines.length;
    const omitted = totalPaths - GLOB_MAX_PATHS;

    const content = [
      headerLine,
      ...keptPaths,
      `\n... and ${omitted} more file(s) (${totalPaths} total)`,
    ].join('\n');

    return {
      content,
      wasTruncated: true,
      originalLength,
      summary: `Glob results truncated: showing ${GLOB_MAX_PATHS} of ${totalPaths} files`,
    };
  }

  // ---------------------------------------------------------------------------
  //  File read output
  // ---------------------------------------------------------------------------

  private formatReadFileOutput(
    raw: string,
    originalLength: number,
  ): FormattedOutput {
    const lines = raw.split('\n');

    // Detect metadata header (e.g. "IMPORTANT: The file content has been truncated.")
    let headerEnd = 0;
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      if (
        lines[i].startsWith('---') ||
        lines[i].startsWith('IMPORTANT:') ||
        lines[i].startsWith('Status:') ||
        lines[i].startsWith('Action:')
      ) {
        headerEnd = i + 1;
      }
    }

    const headerLines = lines.slice(0, headerEnd);
    const contentLines = lines.slice(headerEnd);
    const totalContentLines = contentLines.length;

    if (totalContentLines <= READ_FILE_HEAD_LINES + READ_FILE_TAIL_LINES) {
      return this.formatGenericOutput(raw, originalLength);
    }

    const head = contentLines.slice(0, READ_FILE_HEAD_LINES);
    const tail = contentLines.slice(-READ_FILE_TAIL_LINES);
    const omitted =
      totalContentLines - READ_FILE_HEAD_LINES - READ_FILE_TAIL_LINES;

    const content = [
      ...headerLines,
      ...head,
      `\n... (${omitted} lines truncated) ...\n`,
      ...tail,
    ].join('\n');

    return {
      content,
      wasTruncated: true,
      originalLength,
      summary: `File content truncated: showing first ${READ_FILE_HEAD_LINES} and last ${READ_FILE_TAIL_LINES} lines of ${totalContentLines}`,
    };
  }

  // ---------------------------------------------------------------------------
  //  Generic fallback
  // ---------------------------------------------------------------------------

  private formatGenericOutput(
    raw: string,
    originalLength: number,
  ): FormattedOutput {
    const lines = raw.split('\n');
    if (lines.length <= GENERIC_HEAD_LINES) {
      // Line count is fine — must be long lines. Do a char-based head+tail.
      return this.formatByChars(raw, originalLength);
    }

    const head = lines.slice(0, GENERIC_HEAD_LINES);
    const omitted = lines.length - GENERIC_HEAD_LINES;

    const content = [
      ...head,
      `\n... (truncated, ${omitted} more lines, ${lines.length} total)`,
    ].join('\n');

    return {
      content,
      wasTruncated: true,
      originalLength,
      summary: `Output truncated: showing first ${GENERIC_HEAD_LINES} of ${lines.length} lines`,
    };
  }

  /**
   * Character-based truncation when line count is acceptable but total
   * character count exceeds the limit. Uses 30%/70% head/tail split.
   */
  private formatByChars(
    raw: string,
    originalLength: number,
  ): FormattedOutput {
    if (raw.length <= this.maxOutputChars) {
      return { content: raw, wasTruncated: false, originalLength };
    }

    const headChars = Math.floor(this.maxOutputChars * 0.3);
    const tailChars = Math.floor(this.maxOutputChars * 0.7);
    const omitted = raw.length - headChars - tailChars;

    const content = `${raw.slice(0, headChars)}\n\n... (${omitted} characters truncated) ...\n\n${raw.slice(-tailChars)}`;

    return {
      content,
      wasTruncated: true,
      originalLength,
      summary: `Output truncated: ${omitted} characters omitted from middle`,
    };
  }
}

function countLines(s: string): number {
  let count = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) count++;
  }
  return count;
}
