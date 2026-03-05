# Gemini CLI Improvement Deep Dive & Design

## 1. Internal vs Public Architecture

### The Internal Setup
The internal Google Gemini CLI is **the same TypeScript codebase** as the public repo. The only internal component is a Python HTTP proxy:

**Path**: `//depot/google3/learning/genai/beyond/devtools/gemini_api_proxy/`
**Owner**: bbiggs
**Backend**: `blade:google.ai.generativelanguage.v1main.generativeservice-preprod`

```
gemini CLI (TypeScript) --HTTP--> gemini_api_proxy (Python) --Stubby--> GenAI Backend
                                       |
                                       +--> Sawmill Logger (GWSLog)
                                       +--> Cloud Code Experiments (RPC)
                                       +--> ModelClient (Evergreen, for custom models)
```

### Proxy Configuration Flags
| Flag | Default | Purpose |
|------|---------|---------|
| `--genai_backend` | `generativeservice-preprod` | Stubby backend target |
| `--port` | `8000` | Local proxy port |
| `--project` | `''` | Project name override |
| `--project_max_shard` | `0` | Shard project with `-XX` suffix |
| `--model_url` | `''` | Custom model via DeepMind's Evergreen ModelClient |
| `--use_loas_credentials` | `false` | LOAS auth instead of Gaia MINT |
| `--beyond_quota_bucket_key` | `None` | Quota bucket `team/name` format |
| `--enable_sawmill_logging` | `true` | Internal telemetry to ULS |
| `--sawmill_sanitize_logs` | `false` | Strip user prompts from logs |
| `--experiments_file` | `''` | Write experiment flags to file |
| `--key` | `''` | API key (or env `GEMINI_API_KEY`) |

### Key Internal Features
1. **Gaia MINT Auth** - Corp SSO via `CredentialExchanger`, scope `API_GENERATIVE_LANGUAGE`
2. **Project Sharding** - Deterministic user→shard mapping (seeded by MDB username), automatic failover on `RESOURCE_EXHAUSTED`
3. **Recitation Override** - `CODE_AI_POLICY` override for code generation
4. **Quota Buckets** - `QuotaBucketExtension` for team-specific quota
5. **Custom Models** - `models/custom` routes to Evergreen ModelClient (unreleased models)
6. **Experiment Flags** - Fetched from `cloudcode-prod` via `ListExperiments` RPC

---

## 2. Model Routing (Already in Public CLI!)

The public CLI has a **complete model routing system** at `packages/core/src/routing/`:

### Strategy Chain (evaluated in order)
1. **FallbackStrategy** - Flash fallback for error recovery
2. **OverrideStrategy** - Forced model directive
3. **ApprovalModeStrategy** - Route based on approval mode
4. **GemmaClassifierStrategy** - Local Gemma model for classification (experimental)
5. **ClassifierStrategy** - LLM-based classifier (flash→pro routing)
6. **NumericalClassifierStrategy** - Numerical classifier
7. **DefaultStrategy** - Use configured model (terminal)

### ClassifierStrategy Details
- Uses Flash to classify task complexity as `flash` (simple) or `pro` (complex)
- Rubric: 4+ steps = pro, strategic planning = pro, deep debugging = pro
- Sends last 4 non-tool history turns for context
- Logs `ModelRouting` telemetry event with reasoning

### What This Means
Your feature branch's "model tiering" is **redundant** with the existing routing system! The public CLI already has dynamic model selection. What's needed is:
- **Subagent-specific routing** - Ensure codebase-investigator always routes to flash
- **Agent team model routing** - Teammates use tiered models based on role
- **Integration** with existing `ModelRouterService`

---

## 3. Experiment Flags System

### How It Works
1. Proxy fetches flags via `CloudCode.ListExperiments` RPC at startup
2. Writes JSON to a file (specified by `--experiments_file`)
3. CLI reads via `GEMINI_EXP` env var → `code_assist/experiments/experiments.ts`
4. Flags keyed by `flagId` (integer), values are bool/int/float/string/list

### Notable Experiment Values (from testdata)
- `CHAT_CLIENT_CLOUD_CODE_GEMINI_2_0_FLASH_001` - Flash model identifier
- `/ml/m2p-role-prod-intentclassifiergca-servo-owner/prod.intentclassifiergca` - Intent classifier endpoint
- `0.7` threshold (flagId 45740197) - Likely classifier confidence threshold
- `3500000` - Likely token limit value
- `"wald_word3"`, `"wholefile"`, `"whitespace"` - Edit strategy flags
- `"Gemini 3 Flash and Pro are now available..."` - Feature announcement message

---

## 4. Feature Branch Wiring Analysis

| Feature | Status | Wired? | Evidence |
|---------|--------|--------|----------|
| **Auto Memory (load)** | WIRED | `environmentContext.ts:62` calls `loadAutoMemories()` → injected into `<auto_memories>` tag in session context |
| **Auto Memory (save)** | UNWIRED | `AutoMemoryService.processConversationTurn()` is never called from the agent loop — `fireAndForget()` not invoked |
| **Memory Import** | UNWIRED | `resolveImports`, `loadLocalMemory`, `loadUserMemory`, `loadScopedRules` — only defined, never called |
| **Compact Instructions** | WIRED | `chatCompressionService.ts:372` calls `getEffectiveCompactInstructions()` |
| **Prompt Caching** | UNWIRED | `PromptCachingService` is standalone, not used in `contentGenerator.ts` or `client.ts` |
| **Model Tiering** | PARTIAL | `codebase-investigator.ts` has model config alias, but existing `routing/` system is the real mechanism |
| **Agent Teams** | PARTIALLY WIRED | `TeammateAgentTool` defined with full tool schema, exported from `team/index.ts`, but NOT registered in tool registry |
| **Verify Loop** | PROMPT-ONLY | Instructions in `snippets.ts`, no actual test runner integration |

---

## 5. Telemetry Events (What Google Tracks)

48 event types logged. Key ones for our improvements:
- `model_routing` - decision_model, source, latency, reasoning, classifier_threshold
- `chat_compression` - tokens_before, tokens_after
- `tool_output_masking` - tokens_before/after, masked_count
- `rewind` - outcome (success/failure)
- `plan_execution` - approval_mode
- `agent_start/finish` - agent_id, name, duration, turn_count, terminate_reason
- `agent_recovery_attempt` - reason, success
- `llm_loop_check` - flash_confidence, main_model_confidence

---

## 6. Remaining Work Items (Prioritized)

### P0: Wire Existing Stubs
1. **Auto Memory Save** - Hook `fireAndForget()` into agent loop after user messages
2. **Memory Import** - Call `resolveImports`, `loadLocalMemory`, `loadUserMemory`, `loadScopedRules` in memory loading pipeline
3. **Agent Teams** - Register `TeammateAgentTool` in tool registry
4. **Prompt Caching** - Wire into `contentGenerator.ts`, call `GoogleAICacheManager.create()`

### P1: Enhance Existing Systems
5. **Model Tiering** - Integrate with existing `ModelRouterService`, add role-based routing for teammates
6. **Verify Loop** - Add actual test runner detection & auto-execution after edits
7. **Compression** - Add conversation branching, selective rewind (undo N turns)

### P2: New Features
8. **Enhanced Checkpoint UI** - `/checkpoint list`, `/rewind <N>` commands
9. **Session Persistence** - Resume sessions across terminal restarts
10. **Token Budget Display** - Real-time context usage indicator
11. **Smart Context Selection** - Relevance-based file inclusion in prompts
