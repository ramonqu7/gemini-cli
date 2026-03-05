/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandActionReturn } from './types.js';
import {
  analyzeProject,
  generateGeminiMd,
} from '../services/projectAnalyzerService.js';
import type { ProjectInfo } from '../services/projectAnalyzerService.js';

export { type ProjectInfo } from '../services/projectAnalyzerService.js';

/**
 * Result of the init command, including the generated content and project info
 * when a new GEMINI.md is created.
 */
export interface InitResult {
  action: CommandActionReturn;
  /** The generated GEMINI.md content, if a new file was created. */
  generatedContent: string | null;
  /** The detected project info, if analysis was performed. */
  projectInfo: ProjectInfo | null;
}

export function performInit(
  doesGeminiMdExist: boolean,
  targetDir?: string,
): InitResult {
  if (doesGeminiMdExist) {
    return {
      action: {
        type: 'message',
        messageType: 'info',
        content:
          'A GEMINI.md file already exists in this directory. No changes were made.',
      },
      generatedContent: null,
      projectInfo: null,
    };
  }

  // If no targetDir provided, fall back to LLM-based analysis
  if (!targetDir) {
    return {
      action: {
        type: 'submit_prompt',
        content: buildLlmAnalysisPrompt(),
      },
      generatedContent: null,
      projectInfo: null,
    };
  }

  // Fast file-existence-based analysis
  const projectInfo = analyzeProject(targetDir);
  const content = generateGeminiMd(projectInfo);

  return {
    action: {
      type: 'submit_prompt',
      content: buildLlmAnalysisPrompt(content),
    },
    generatedContent: content,
    projectInfo,
  };
}

/**
 * Builds the LLM prompt for project analysis.
 * If a pre-generated scaffold is provided, the LLM is instructed to refine it
 * rather than start from scratch.
 */
function buildLlmAnalysisPrompt(scaffold?: string): string {
  if (scaffold) {
    return `You are an AI agent that brings the power of Gemini directly into the terminal. Your task is to analyze the current directory and generate a comprehensive GEMINI.md file to be used as instructional context for future interactions.

I've already done a quick scan of the project and generated this initial scaffold:

\`\`\`markdown
${scaffold}\`\`\`

**Your task:**

1. Read the README file (e.g., \`README.md\`, \`README.txt\`) if it exists.
2. Read up to 5 additional key files to understand the project better.
3. Enhance the scaffold above with:
   - A concise **Project Overview** section describing the project's purpose and architecture.
   - Any additional build/test/lint commands you discover.
   - Any coding conventions or development practices you can infer.
4. Write the final, complete content to the \`GEMINI.md\` file. Keep it concise and useful.
`;
  }

  return `You are an AI agent that brings the power of Gemini directly into the terminal. Your task is to analyze the current directory and generate a comprehensive GEMINI.md file to be used as instructional context for future interactions.

**Analysis Process:**

1.  **Initial Exploration:**
    *   Start by listing the files and directories to get a high-level overview of the structure.
    *   Read the README file (e.g., \`README.md\`, \`README.txt\`) if it exists. This is often the best place to start.

2.  **Iterative Deep Dive (up to 10 files):**
    *   Based on your initial findings, select a few files that seem most important (e.g., configuration files, main source files, documentation).
    *   Read them. As you learn more, refine your understanding and decide which files to read next. You don't need to decide all 10 files at once. Let your discoveries guide your exploration.

3.  **Identify Project Type:**
    *   **Code Project:** Look for clues like \`package.json\`, \`requirements.txt\`, \`pom.xml\`, \`go.mod\`, \`Cargo.toml\`, \`build.gradle\`, or a \`src\` directory. If you find them, this is likely a software project.
    *   **Non-Code Project:** If you don't find code-related files, this might be a directory for documentation, research papers, notes, or something else.

**GEMINI.md Content Generation:**

**For a Code Project:**

*   **Project Overview:** Write a clear and concise summary of the project's purpose, main technologies, and architecture.
*   **Building and Running:** Document the key commands for building, running, and testing the project. Infer these from the files you've read (e.g., \`scripts\` in \`package.json\`, \`Makefile\`, etc.). If you can't find explicit commands, provide a placeholder with a TODO.
*   **Development Conventions:** Describe any coding styles, testing practices, or contribution guidelines you can infer from the codebase.

**For a Non-Code Project:**

*   **Directory Overview:** Describe the purpose and contents of the directory. What is it for? What kind of information does it hold?
*   **Key Files:** List the most important files and briefly explain what they contain.
*   **Usage:** Explain how the contents of this directory are intended to be used.

**Final Output:**

Write the complete content to the \`GEMINI.md\` file. The output must be well-formatted Markdown.
`;
}
