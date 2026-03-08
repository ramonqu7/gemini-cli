# Harness Engineering + /loop Design

## Summary

Add autonomous operation infrastructure ("harness engineering") and a `/loop`
scheduled-tasks command to Gemini CLI. The harness provides graduated autonomy
within user-defined permission boundaries. `/loop` enables recurring scheduled
prompts that operate within those boundaries.

## Architecture

```
User Interface (/loop, natural language, CLI flags)
        │
Harness Config Layer (settings.json → GEMINI.md → CLI flags)
        │
   ┌────┴────┐
CronService  BudgetEnforcer (token/turn/time tracking, graduated warnings)
   │              │
   └────┬─────────┘
   ScopeEnforcer (directory/command constraints, extends Policy Engine)
        │
   Existing Infrastructure (BackgroundTaskService, GeminiClient, Policy Engine)
```

## Components

### 1. Harness Config (cli/config/harnessConfig.ts)

Layered: settings.json < GEMINI.md < CLI flags. Sections: budget, scope,
checkpoints, loop.

### 2. CronService (core/services/cronService.ts)

Cron parser, interval engine, task registry (50 max), jitter, auto-expiry,
hybrid context (independent default, persistent optional).

### 3. Cron Tools (core/tools/cronTools.ts)

CronCreate, CronList, CronDelete — model-facing, gated by harness config
ceilings.

### 4. /loop Command (cli/ui/commands/loopCommand.ts)

Interactive shorthand: `/loop 5m check build`, `/loop cancel <id>`,
`/loop list`.

### 5. BudgetEnforcer (core/services/budgetEnforcerService.ts)

Tracks turns/tokens/time. 80% warning, 95% checkpoint pause, 100% hard stop.

### 6. ScopeEnforcer (core/services/scopeEnforcerService.ts)

Directory allowlist, command blocklist, blocked tools. Pre-tool-call hook into
Policy Engine.

## Decisions

- Layered config (B): settings.json + GEMINI.md + CLI flags
- Hybrid context (C): independent by default, persistent option for stateful
  loops
- Model gets tools (A): CronCreate/List/Delete exposed, harness sets ceilings
- Graduated budget (C): warn 80%, pause 95%, stop 100%
- Full stack (A): all 6 components in one PR
