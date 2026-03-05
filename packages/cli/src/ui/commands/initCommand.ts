/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { performInit } from '@google/gemini-cli-core';

export const initCommand: SlashCommand = {
  name: 'init',
  description: 'Analyzes the project and creates a tailored GEMINI.md file',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (
    context: CommandContext,
    _args: string,
  ): Promise<SlashCommandActionReturn> => {
    if (!context.services.config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Configuration not available.',
      };
    }
    const targetDir = context.services.config.getTargetDir();
    const geminiMdPath = path.join(targetDir, 'GEMINI.md');

    const { action, generatedContent, projectInfo } = performInit(
      fs.existsSync(geminiMdPath),
      targetDir,
    );

    if (action.type === 'submit_prompt') {
      // Seed the GEMINI.md with detected content or empty
      const initialContent = generatedContent ?? '';
      fs.writeFileSync(geminiMdPath, initialContent, 'utf8');

      if (projectInfo) {
        // Show a summary of what was detected
        const detected: string[] = [];
        if (projectInfo.languages.length > 0) {
          detected.push(`Language: ${projectInfo.languages.join(', ')}`);
        }
        if (projectInfo.packageManager) {
          detected.push(`Package manager: ${projectInfo.packageManager}`);
        }
        if (projectInfo.testFramework) {
          detected.push(`Test framework: ${projectInfo.testFramework}`);
        }
        if (projectInfo.linter) {
          detected.push(`Linter: ${projectInfo.linter}`);
        }
        if (projectInfo.isMonorepo) {
          detected.push('Monorepo detected');
        }

        const summary =
          detected.length > 0 ? `Detected: ${detected.join(' | ')}. ` : '';

        context.ui.addItem(
          {
            type: 'info',
            text: `${summary}GEMINI.md scaffolded. Now analyzing the project for a detailed description.`,
          },
          Date.now(),
        );
      } else {
        context.ui.addItem(
          {
            type: 'info',
            text: 'Empty GEMINI.md created. Now analyzing the project to populate it.',
          },
          Date.now(),
        );
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return action as SlashCommandActionReturn;
  },
};
