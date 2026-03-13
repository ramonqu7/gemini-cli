/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { HarnessScopeConfig } from './harnessConfig.js';

export class ScopeEnforcerService {
  private readonly resolvedAllowedDirs: string[];
  private readonly blockedCommands: string[];
  private readonly blockedTools: string[];

  constructor(config: HarnessScopeConfig, cwd: string) {
    this.resolvedAllowedDirs = config.allowedDirectories.map((dir) =>
      path.resolve(cwd, dir),
    );
    this.blockedCommands = config.blockedCommands;
    this.blockedTools = config.blockedTools;
  }

  isPathAllowed(filePath: string): boolean {
    if (this.resolvedAllowedDirs.length === 0) {
      return true;
    }
    const resolved = path.resolve(filePath);
    return this.resolvedAllowedDirs.some(
      (dir) => resolved === dir || resolved.startsWith(dir + path.sep),
    );
  }

  isCommandAllowed(command: string): boolean {
    const trimmed = command.trim();
    return !this.blockedCommands.some((blocked) => {
      const escaped = blocked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp('(?:^|\\b)' + escaped + '(?:\\b|$)');
      return pattern.test(trimmed);
    });
  }

  isToolAllowed(toolName: string): boolean {
    return !this.blockedTools.includes(toolName);
  }

  getViolationMessage(
    type: 'path' | 'command' | 'tool',
    value: string,
  ): string {
    switch (type) {
      case 'path':
        return `Path access denied: "${value}" is outside the allowed directories.`;
      case 'command':
        return `Command blocked: "${value}" matches a blocked command pattern.`;
      case 'tool':
        return `Tool blocked: "${value}" is not permitted by the current harness configuration.`;
      default:
        return `Violation: "${value}" is not permitted.`;
    }
  }
}
