# Gemini CLI Improvement Spec

## Goal: Port key Claude Code features to Gemini CLI

### Project Structure

- Monorepo: `packages/core/src/` is the main codebase
- TypeScript, ESM modules
- Key dirs: agents/, tools/, scheduler/, hooks/, skills/, config/, services/,
  core/, prompts/

### Tasks (in priority order)

---

## Task 1: Auto Memory System

**What**: Claude Code has "auto memory" where the agent automatically writes
learnings to a MEMORY.md file based on user corrections and discovered patterns.
Gemini CLI has `GEMINI.md` but no auto memory.

**Implementation**:

1. Look at `tools/memoryTool.ts` - it already has
   `MEMORY_SECTION_HEADER = '## Gemini Added Memories'`
2. Add a new service `services/autoMemoryService.ts` that:
   - After each user correction (detected from conversation patterns like "no,
     actually...", "that's wrong", "use X instead")
   - Automatically appends a memory entry to the GEMINI.md file under
     `## Gemini Added Memories`
   - Caps at 200 lines of auto memory (oldest entries get pruned)
   - Each entry: `- [YYYY-MM-DD] <learning>`
3. Add a hook in the main agent loop to trigger auto memory after user messages
4. Add config option `autoMemory: boolean` (default: true) in `config/config.ts`

**Reference files**:

- `packages/core/src/tools/memoryTool.ts` (existing memory tool)
- `packages/core/src/config/memory.ts` (hierarchical memory config)
- `packages/core/src/services/chatCompressionService.ts` (for pattern of service
  integration)

---

## Task 2: Subagent Model Tiering (Explore with Flash)

**What**: Claude Code uses Haiku (cheap/fast model) for its Explore subagent
(read-only codebase search). Gemini CLI should use Flash for read-only
exploration tasks.

**Implementation**:

1. Look at `agents/codebase-investigator.ts` - this is similar to Claude Code's
   "Explore" agent
2. Ensure the codebase-investigator uses `gemini-2.0-flash` instead of the
   default model
3. The agent should be restricted to read-only tools: ReadFile, ReadManyFiles,
   Grep, Glob, Ls
4. Add model override capability per-agent in the agent definition

**Reference files**:

- `packages/core/src/agents/codebase-investigator.ts`
- `packages/core/src/agents/generalist-agent.ts`
- `packages/core/src/config/defaultModelConfigs.ts`

---

## Task 3: Enhanced Context Compression

**What**: Custom compact instructions and checkpoint-based targeted
summarization.

**Implementation**:

1. In `services/chatCompressionService.ts` - add support for custom compression
   instructions
2. Read `## Compact Instructions` section from GEMINI.md
3. Pass these instructions to the compression prompt in `core/prompts.ts`
4. Add targeted summarization: compress only messages after a certain point

**Reference files**:

- `packages/core/src/services/chatCompressionService.ts`
- `packages/core/src/core/prompts.ts`
- `packages/core/src/utils/summarizer.ts`

---

## Task 4: Memory Hierarchy & @import

**What**: Multi-level GEMINI.md and @import syntax.

**Implementation**:

1. Add `GEMINI.local.md` support (project-specific, gitignored)
2. Add `~/.gemini/GEMINI.md` for user-level instructions
3. Implement `@path/to/file` import syntax with max depth 5
4. Add `.gemini/rules/*.md` directory support for scoped rules

**Reference files**:

- `packages/core/src/config/memory.ts`
- `packages/core/src/tools/memoryTool.ts`

---

## Task 5: Prompt Caching Integration

**What**: Use Gemini's cached content API to cache system prompt + GEMINI.md.

**Implementation**:

1. Create cached content for system instructions + GEMINI.md + tool definitions
2. Reuse cached content ID for subsequent requests in the same session
3. Invalidate cache when GEMINI.md changes

**Reference files**:

- `packages/core/src/core/client.ts`
- `packages/core/src/core/contentGenerator.ts`

---

## Task 6: Agent Teams with tmux Display

**What**: Multiple agents with shared task list, inter-agent communication, tmux
display.

**Implementation**:

1. Create `agents/team/` module
2. Components: team-manager, shared-task-list, teammate-messaging, tmux-display
3. Each teammate has its own context window
4. Lead coordinates, teammates communicate directly

---

## Task 7: System Prompt Enhancement (Verify Loop)

**What**: Enforce "Explore → Plan → Code → Verify" workflow.

**Implementation**:

1. In `prompts/snippets.ts` add stronger verification instructions
2. After code changes, always run relevant tests
3. After editing, re-read file to verify changes
4. Plan mode enforcement for complex tasks

**Reference files**:

- `packages/core/src/prompts/snippets.ts`

---

## Build & Test

```bash
npm install
npm run build
npm test
```

## Notes

- Keep changes backward compatible
- Add tests for new features
- Follow existing code patterns
- Apache 2.0 license headers on new files
