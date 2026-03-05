/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ToolOutputFormatterService } from './toolOutputFormatterService.js';
import {
  SHELL_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  LS_TOOL_NAME,
} from '../tools/tool-names.js';

function makeLines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join(
    '\n',
  );
}

describe('ToolOutputFormatterService', () => {
  const formatter = new ToolOutputFormatterService({
    maxOutputLines: 200,
    maxOutputChars: 50000,
  });

  describe('short output passthrough', () => {
    it('returns output unchanged when within limits', () => {
      const result = formatter.formatOutput(SHELL_TOOL_NAME, 'hello world');
      expect(result.wasTruncated).toBe(false);
      expect(result.content).toBe('hello world');
      expect(result.originalLength).toBe('hello world'.length);
    });
  });

  // ---------------------------------------------------------------------------
  //  Shell output
  // ---------------------------------------------------------------------------
  describe('shell output formatting', () => {
    it('preserves exit code and error while truncating stdout', () => {
      const stdout = makeLines(300, 'stdout');
      const raw = `Output: ${stdout}\nError: some error message\nExit Code: 1`;
      const result = formatter.formatOutput(SHELL_TOOL_NAME, raw);

      expect(result.wasTruncated).toBe(true);
      // Exit code and error must be preserved
      expect(result.content).toContain('Exit Code: 1');
      expect(result.content).toContain('Error: some error message');
      // Truncation marker must appear
      expect(result.content).toContain('lines truncated');
      // First and last stdout lines should be present
      expect(result.content).toContain('stdout 1');
      expect(result.content).toContain('stdout 300');
      expect(result.summary).toContain('Shell output truncated');
    });

    it('handles shell output without section format via fallback', () => {
      const raw = makeLines(300, 'raw');
      const result = formatter.formatOutput(SHELL_TOOL_NAME, raw);

      expect(result.wasTruncated).toBe(true);
      expect(result.content).toContain('raw 1');
      expect(result.content).toContain('truncated');
    });

    it('keeps small shell output intact even with sections', () => {
      const raw = `Output: hello\nExit Code: 0`;
      const result = formatter.formatOutput(SHELL_TOOL_NAME, raw);
      expect(result.wasTruncated).toBe(false);
      expect(result.content).toBe(raw);
    });
  });

  // ---------------------------------------------------------------------------
  //  Grep output
  // ---------------------------------------------------------------------------
  describe('grep output formatting', () => {
    function makeGrepOutput(fileCount: number): string {
      const header = `Found ${fileCount * 3} matches for pattern "foo" in path "/src":`;
      const groups = Array.from({ length: fileCount }, (_, i) => {
        return `File: /src/file${i + 1}.ts\nL10: foo bar\nL20: foo baz\nL30: foo qux`;
      });
      return `${header}\n---\n${groups.join('\n---\n')}\n---`;
    }

    it('keeps all file groups when count is within limit', () => {
      const raw = makeGrepOutput(10);
      const result = formatter.formatOutput(GREP_TOOL_NAME, raw);

      // 10 files < 15 file limit, but may exceed line count — check actual
      // The formatter should NOT truncate by file groups in this case.
      expect(result.content).toContain('file10.ts');
    });

    it('truncates to max files when there are many file groups', () => {
      const raw = makeGrepOutput(30);
      const result = formatter.formatOutput(GREP_TOOL_NAME, raw);

      expect(result.wasTruncated).toBe(true);
      // Should contain the first 15 files
      expect(result.content).toContain('file1.ts');
      expect(result.content).toContain('file15.ts');
      // Should NOT contain files beyond the limit
      expect(result.content).not.toContain('file16.ts');
      // Summary message
      expect(result.content).toContain('15 more file(s) with matches');
      expect(result.content).toContain('30 files total');
      expect(result.summary).toContain('15 of 30');
    });
  });

  // ---------------------------------------------------------------------------
  //  Glob output
  // ---------------------------------------------------------------------------
  describe('glob output formatting', () => {
    function makeGlobOutput(pathCount: number): string {
      const header = `Found ${pathCount} file(s) matching "*.ts" within /src, sorted by modification time (newest first):`;
      const paths = Array.from(
        { length: pathCount },
        (_, i) => `/src/file${i + 1}.ts`,
      );
      return `${header}\n${paths.join('\n')}`;
    }

    it('keeps all paths when count is within limit', () => {
      const raw = makeGlobOutput(20);
      const result = formatter.formatOutput(GLOB_TOOL_NAME, raw);
      expect(result.content).toContain('file20.ts');
    });

    it('truncates to max paths with summary', () => {
      const raw = makeGlobOutput(100);
      const result = formatter.formatOutput(GLOB_TOOL_NAME, raw);

      expect(result.wasTruncated).toBe(true);
      expect(result.content).toContain('file1.ts');
      expect(result.content).toContain('file30.ts');
      expect(result.content).not.toContain('file31.ts');
      expect(result.content).toContain('70 more file(s)');
      expect(result.content).toContain('100 total');
    });

    it('works for ls tool output too', () => {
      const raw = makeGlobOutput(100);
      const result = formatter.formatOutput(LS_TOOL_NAME, raw);
      expect(result.wasTruncated).toBe(true);
      expect(result.content).toContain('70 more file(s)');
    });
  });

  // ---------------------------------------------------------------------------
  //  Read file output
  // ---------------------------------------------------------------------------
  describe('read file output formatting', () => {
    it('preserves header and shows head+tail of content', () => {
      const header =
        'IMPORTANT: The file content has been truncated.\nStatus: Showing lines 1-500 of 1000 total lines.\nAction: To read more, use start_line.\n--- FILE CONTENT (truncated) ---';
      const contentLines = makeLines(400, 'code');
      const raw = `${header}\n${contentLines}`;

      const result = formatter.formatOutput(READ_FILE_TOOL_NAME, raw);

      expect(result.wasTruncated).toBe(true);
      // Header should be preserved
      expect(result.content).toContain('IMPORTANT:');
      // First and last content lines
      expect(result.content).toContain('code 1');
      expect(result.content).toContain('code 400');
      // Truncation marker
      expect(result.content).toContain('lines truncated');
    });

    it('passes through small file reads', () => {
      const raw = 'line 1\nline 2\nline 3';
      const result = formatter.formatOutput(READ_FILE_TOOL_NAME, raw);
      expect(result.wasTruncated).toBe(false);
      expect(result.content).toBe(raw);
    });
  });

  // ---------------------------------------------------------------------------
  //  Generic fallback
  // ---------------------------------------------------------------------------
  describe('generic output formatting', () => {
    it('truncates by lines with count summary', () => {
      const raw = makeLines(300, 'generic');
      const result = formatter.formatOutput('some_unknown_tool', raw);

      expect(result.wasTruncated).toBe(true);
      expect(result.content).toContain('generic 1');
      expect(result.content).toContain('generic 150');
      expect(result.content).not.toContain('generic 151\n');
      expect(result.content).toContain('150 more lines');
      expect(result.content).toContain('300 total');
    });

    it('truncates by characters when lines are few but long', () => {
      const longLine = 'x'.repeat(60000);
      const smallFormatter = new ToolOutputFormatterService({
        maxOutputLines: 200,
        maxOutputChars: 50000,
      });
      const result = smallFormatter.formatOutput('some_tool', longLine);

      expect(result.wasTruncated).toBe(true);
      expect(result.content).toContain('characters truncated');
      expect(result.content.length).toBeLessThan(longLine.length);
    });
  });

  // ---------------------------------------------------------------------------
  //  Edge cases
  // ---------------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles empty string', () => {
      const result = formatter.formatOutput(SHELL_TOOL_NAME, '');
      expect(result.wasTruncated).toBe(false);
      expect(result.content).toBe('');
    });

    it('handles output with only error sections (no Output:)', () => {
      const raw = `Error: something went wrong\nExit Code: 127`;
      const result = formatter.formatOutput(SHELL_TOOL_NAME, raw);
      // Small enough to not truncate
      expect(result.wasTruncated).toBe(false);
      expect(result.content).toBe(raw);
    });

    it('returns correct originalLength regardless of truncation', () => {
      const raw = makeLines(300, 'test');
      const result = formatter.formatOutput(SHELL_TOOL_NAME, raw);
      expect(result.originalLength).toBe(raw.length);
    });
  });
});
