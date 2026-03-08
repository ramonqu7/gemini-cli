# Harness Engineering + /loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Add autonomous operation infrastructure ("harness engineering") with
graduated budgets, scope constraints, and a `/loop` scheduled-tasks command to
Gemini CLI.

**Architecture:** Layered config (settings.json < GEMINI.md < CLI flags) defines
harness guardrails. A CronService provides the scheduling engine. Three
model-facing tools (CronCreate/List/Delete) let the model schedule loops.
BudgetEnforcerService tracks token/turn/time usage with graduated warnings
(80%/95%/100%). ScopeEnforcerService constrains directories and commands.

**Tech Stack:** TypeScript, Node.js EventEmitter, vitest, existing Policy Engine
integration

---

### Task 1: Cron Service — Types and Interval Parser

**Files:**

- Create: `packages/core/src/services/cronService.ts`
- Create: `packages/core/src/services/cronService.test.ts`

**Step 1: Write the failing tests for interval parsing**

```typescript
// packages/core/src/services/cronService.test.ts
import { describe, it, expect } from 'vitest';
import { parseInterval, CronTask, CronService } from './cronService.js';

describe('parseInterval', () => {
  it('parses minutes', () => {
    expect(parseInterval('5m')).toEqual({ minutes: 5 });
  });

  it('parses hours', () => {
    expect(parseInterval('2h')).toEqual({ minutes: 120 });
  });

  it('parses seconds and rounds up to 1 minute', () => {
    expect(parseInterval('30s')).toEqual({ minutes: 1 });
  });

  it('parses days', () => {
    expect(parseInterval('1d')).toEqual({ minutes: 1440 });
  });

  it('returns null for invalid input', () => {
    expect(parseInterval('abc')).toBeNull();
    expect(parseInterval('')).toBeNull();
  });

  it('defaults to 10 minutes when no interval given', () => {
    expect(parseInterval(undefined)).toEqual({ minutes: 10 });
  });
});
```

**Step 2: Run test to verify it fails**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/core/src/services/cronService.test.ts`
Expected: FAIL — module not found

**Step 3: Write the CronService with interval parser, task registry, and
scheduler**

```typescript
// packages/core/src/services/cronService.ts
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

export interface ParsedInterval {
  minutes: number;
}

export function parseInterval(
  input: string | undefined,
): ParsedInterval | null {
  if (!input) {
    return { minutes: 10 }; // default
  }

  const match = input.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 's':
      return { minutes: Math.max(1, Math.ceil(value / 60)) };
    case 'm':
      return { minutes: value };
    case 'h':
      return { minutes: value * 60 };
    case 'd':
      return { minutes: value * 1440 };
    default:
      return null;
  }
}

export function parseCronExpression(
  expr: string,
): {
  minute: string;
  hour: string;
  dom: string;
  month: string;
  dow: string;
} | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  return {
    minute: parts[0],
    hour: parts[1],
    dom: parts[2],
    month: parts[3],
    dow: parts[4],
  };
}

export function intervalToCron(interval: ParsedInterval): string {
  const m = interval.minutes;
  if (m < 60) {
    const step = m <= 0 ? 1 : m;
    return `*/${step} * * * *`;
  }
  if (m < 1440) {
    const hours = Math.floor(m / 60);
    return `0 */${hours} * * *`;
  }
  return `0 0 * * *`; // daily
}

export type CronTaskStatus = 'active' | 'paused' | 'expired';

export interface CronTask {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  persistent: boolean;
  status: CronTaskStatus;
  createdAt: number;
  lastFiredAt?: number;
  fireCount: number;
  expiresAt: number;
}

interface CronServiceEvents {
  'task-due': [CronTask];
  'task-created': [CronTask];
  'task-deleted': [CronTask];
  'task-expired': [CronTask];
}

export interface CronServiceConfig {
  maxConcurrent: number;
  maxDurationMs: number; // default 3 days
  enabled: boolean;
}

const DEFAULT_CONFIG: CronServiceConfig = {
  maxConcurrent: 5,
  maxDurationMs: 3 * 24 * 60 * 60 * 1000, // 3 days
  enabled: true,
};

export class CronService extends EventEmitter<CronServiceEvents> {
  private tasks: Map<string, CronTask> = new Map();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private config: CronServiceConfig;
  private busy = false;

  constructor(config: Partial<CronServiceConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    if (this.tickInterval || !this.config.enabled) return;
    this.tickInterval = setInterval(() => this.tick(), 1000);
    // Don't keep process alive just for cron
    this.tickInterval.unref();
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  createTask(opts: {
    cron: string;
    prompt: string;
    recurring?: boolean;
    persistent?: boolean;
  }): CronTask | null {
    if (!this.config.enabled) return null;
    if (this.tasks.size >= this.config.maxConcurrent) return null;

    const id = randomBytes(4).toString('hex');
    const task: CronTask = {
      id,
      cron: opts.cron,
      prompt: opts.prompt,
      recurring: opts.recurring ?? true,
      persistent: opts.persistent ?? false,
      status: 'active',
      createdAt: Date.now(),
      fireCount: 0,
      expiresAt: Date.now() + this.config.maxDurationMs,
    };

    this.tasks.set(id, task);
    this.emit('task-created', task);
    return task;
  }

  deleteTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    this.tasks.delete(id);
    this.emit('task-deleted', task);
    return true;
  }

  getTask(id: string): CronTask | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): CronTask[] {
    return Array.from(this.tasks.values());
  }

  getActiveTasks(): CronTask[] {
    return this.getAllTasks().filter((t) => t.status === 'active');
  }

  private tick(): void {
    if (this.busy) return;

    const now = Date.now();

    for (const task of this.tasks.values()) {
      if (task.status !== 'active') continue;

      // Check expiry
      if (now >= task.expiresAt) {
        task.status = 'expired';
        this.emit('task-expired', task);
        continue;
      }

      // Check if due
      if (this.isDue(task, now)) {
        task.lastFiredAt = now;
        task.fireCount++;
        this.emit('task-due', task);

        // One-shot tasks self-delete after firing
        if (!task.recurring) {
          this.tasks.delete(task.id);
        }
      }
    }
  }

  private isDue(task: CronTask, now: number): boolean {
    const parsed = parseCronExpression(task.cron);
    if (!parsed) return false;

    const date = new Date(now);
    // Apply deterministic jitter based on task ID
    const jitterMs = this.getJitter(task);
    const adjustedDate = new Date(now - jitterMs);

    const minute = adjustedDate.getMinutes();
    const hour = adjustedDate.getHours();
    const dom = adjustedDate.getDate();
    const month = adjustedDate.getMonth() + 1;
    const dow = adjustedDate.getDay();

    // Only fire once per minute window
    const lastMinute = task.lastFiredAt
      ? Math.floor(task.lastFiredAt / 60000)
      : -1;
    const currentMinute = Math.floor(now / 60000);
    if (lastMinute === currentMinute) return false;

    return (
      this.fieldMatches(parsed.minute, minute) &&
      this.fieldMatches(parsed.hour, hour) &&
      (this.fieldMatches(parsed.dom, dom) ||
        this.fieldMatches(parsed.dow, dow)) &&
      this.fieldMatches(parsed.month, month)
    );
  }

  private fieldMatches(field: string, value: number): boolean {
    if (field === '*') return true;

    // Step: */N
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2), 10);
      return step > 0 && value % step === 0;
    }

    // Range: N-M
    if (field.includes('-')) {
      const [start, end] = field.split('-').map(Number);
      return value >= start && value <= end;
    }

    // List: N,M,O
    if (field.includes(',')) {
      return field.split(',').map(Number).includes(value);
    }

    // Exact value
    return parseInt(field, 10) === value;
  }

  private getJitter(task: CronTask): number {
    // Deterministic jitter from task ID
    const hash = parseInt(task.id.slice(0, 4), 16);
    if (!task.recurring) {
      // One-shot: up to 90 seconds
      return (hash % 90) * 1000;
    }
    // Recurring: up to 10% of period, capped at 15 minutes
    const parsed = parseCronExpression(task.cron);
    if (!parsed) return 0;
    const periodMs = this.estimatePeriodMs(parsed);
    const maxJitter = Math.min(periodMs * 0.1, 15 * 60 * 1000);
    return (hash % Math.max(1, Math.floor(maxJitter / 1000))) * 1000;
  }

  private estimatePeriodMs(cron: { minute: string; hour: string }): number {
    if (cron.minute.startsWith('*/')) {
      return parseInt(cron.minute.slice(2), 10) * 60 * 1000;
    }
    if (cron.hour.startsWith('*/')) {
      return parseInt(cron.hour.slice(2), 10) * 60 * 60 * 1000;
    }
    return 60 * 60 * 1000; // default 1 hour
  }

  formatTaskList(): string {
    const tasks = this.getAllTasks();
    if (tasks.length === 0) return 'No scheduled tasks.';

    const lines = ['Scheduled Tasks:'];
    for (const t of tasks) {
      const prompt =
        t.prompt.length > 60 ? t.prompt.slice(0, 57) + '...' : t.prompt;
      const type = t.recurring ? 'recurring' : 'one-shot';
      lines.push(`  [${t.status}] ${t.id} (${t.cron}, ${type}): ${prompt}`);
    }
    return lines.join('\n');
  }
}
```

**Step 4: Run test to verify it passes**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/core/src/services/cronService.test.ts`
Expected: PASS

**Step 5: Add more tests for CronService class**

Add to `cronService.test.ts`:

```typescript
describe('CronService', () => {
  it('creates a task and assigns an ID', () => {
    const service = new CronService();
    const task = service.createTask({
      cron: '*/5 * * * *',
      prompt: 'check build',
    });
    expect(task).not.toBeNull();
    expect(task!.id).toHaveLength(8);
    expect(task!.status).toBe('active');
  });

  it('rejects when at max concurrent', () => {
    const service = new CronService({ maxConcurrent: 2 });
    service.createTask({ cron: '*/5 * * * *', prompt: 'task 1' });
    service.createTask({ cron: '*/5 * * * *', prompt: 'task 2' });
    const result = service.createTask({
      cron: '*/5 * * * *',
      prompt: 'task 3',
    });
    expect(result).toBeNull();
  });

  it('deletes a task by ID', () => {
    const service = new CronService();
    const task = service.createTask({ cron: '*/5 * * * *', prompt: 'test' })!;
    expect(service.deleteTask(task.id)).toBe(true);
    expect(service.getTask(task.id)).toBeUndefined();
  });

  it('returns false when deleting non-existent task', () => {
    const service = new CronService();
    expect(service.deleteTask('nonexistent')).toBe(false);
  });

  it('lists all tasks', () => {
    const service = new CronService();
    service.createTask({ cron: '*/5 * * * *', prompt: 'task 1' });
    service.createTask({ cron: '0 * * * *', prompt: 'task 2' });
    expect(service.getAllTasks()).toHaveLength(2);
  });

  it('rejects tasks when disabled', () => {
    const service = new CronService({ enabled: false });
    expect(
      service.createTask({ cron: '*/5 * * * *', prompt: 'test' }),
    ).toBeNull();
  });

  it('formats task list', () => {
    const service = new CronService();
    service.createTask({ cron: '*/5 * * * *', prompt: 'check build' });
    const output = service.formatTaskList();
    expect(output).toContain('Scheduled Tasks:');
    expect(output).toContain('check build');
  });

  it('formats empty task list', () => {
    const service = new CronService();
    expect(service.formatTaskList()).toBe('No scheduled tasks.');
  });
});

describe('intervalToCron', () => {
  it('converts minutes to cron', () => {
    expect(intervalToCron({ minutes: 5 })).toBe('*/5 * * * *');
    expect(intervalToCron({ minutes: 15 })).toBe('*/15 * * * *');
  });

  it('converts hours to cron', () => {
    expect(intervalToCron({ minutes: 60 })).toBe('0 */1 * * *');
    expect(intervalToCron({ minutes: 120 })).toBe('0 */2 * * *');
  });

  it('converts days to cron', () => {
    expect(intervalToCron({ minutes: 1440 })).toBe('0 0 * * *');
  });
});
```

**Step 6: Run full test suite**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/core/src/services/cronService.test.ts`
Expected: ALL PASS

**Step 7: Commit**

```bash
git add packages/core/src/services/cronService.ts packages/core/src/services/cronService.test.ts
git commit -m "feat: add CronService with interval parser, task registry, and scheduler"
```

---

### Task 2: Harness Config Types and Parsing

**Files:**

- Create: `packages/core/src/services/harnessConfig.ts`
- Create: `packages/core/src/services/harnessConfig.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/core/src/services/harnessConfig.test.ts
import { describe, it, expect } from 'vitest';
import {
  HarnessConfig,
  DEFAULT_HARNESS_CONFIG,
  mergeHarnessConfig,
  parseDuration,
} from './harnessConfig.js';

describe('parseDuration', () => {
  it('parses minutes', () => {
    expect(parseDuration('30m')).toBe(30 * 60 * 1000);
  });
  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(60 * 60 * 1000);
  });
  it('parses days', () => {
    expect(parseDuration('3d')).toBe(3 * 24 * 60 * 60 * 1000);
  });
  it('returns null for invalid', () => {
    expect(parseDuration('abc')).toBeNull();
  });
});

describe('mergeHarnessConfig', () => {
  it('returns defaults when no overrides', () => {
    const result = mergeHarnessConfig();
    expect(result).toEqual(DEFAULT_HARNESS_CONFIG);
  });

  it('merges partial overrides', () => {
    const result = mergeHarnessConfig({ budget: { maxTurns: 20 } });
    expect(result.budget.maxTurns).toBe(20);
    expect(result.budget.maxDuration).toBe(
      DEFAULT_HARNESS_CONFIG.budget.maxDuration,
    );
  });

  it('deep merges nested scope config', () => {
    const result = mergeHarnessConfig({
      scope: { blockedCommands: ['rm -rf /'] },
    });
    expect(result.scope.blockedCommands).toContain('rm -rf /');
  });
});
```

**Step 2: Run test to verify it fails**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/core/src/services/harnessConfig.test.ts`

**Step 3: Write the harness config module**

```typescript
// packages/core/src/services/harnessConfig.ts

export interface HarnessBudgetConfig {
  maxTurns: number;
  maxDuration: string; // '1h', '30m', '3d'
  warningThreshold: number; // 0.0-1.0, default 0.8
  checkpointThreshold: number; // 0.0-1.0, default 0.95
}

export interface HarnessScopeConfig {
  allowedDirectories: string[];
  blockedCommands: string[];
  blockedTools: string[];
}

export interface HarnessCheckpointConfig {
  every: number; // 0 = disabled, N = pause every N turns
  onFileDelete: boolean;
  onGitOperation: boolean;
}

export interface HarnessLoopConfig {
  enabled: boolean;
  maxConcurrent: number;
  defaultInterval: string;
  maxDuration: string;
}

export interface HarnessConfig {
  budget: HarnessBudgetConfig;
  scope: HarnessScopeConfig;
  checkpoints: HarnessCheckpointConfig;
  loop: HarnessLoopConfig;
}

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
  budget: {
    maxTurns: 100,
    maxDuration: '1h',
    warningThreshold: 0.8,
    checkpointThreshold: 0.95,
  },
  scope: {
    allowedDirectories: [],
    blockedCommands: ['rm -rf /', 'git push --force'],
    blockedTools: [],
  },
  checkpoints: {
    every: 0,
    onFileDelete: true,
    onGitOperation: true,
  },
  loop: {
    enabled: true,
    maxConcurrent: 5,
    defaultInterval: '10m',
    maxDuration: '3d',
  },
};

export function parseDuration(input: string): number | null {
  const match = input.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

export function mergeHarnessConfig(
  ...overrides: Array<Partial<DeepPartial<HarnessConfig>> | undefined>
): HarnessConfig {
  let result: HarnessConfig = structuredClone(DEFAULT_HARNESS_CONFIG);

  for (const override of overrides) {
    if (!override) continue;
    if (override.budget) {
      result.budget = { ...result.budget, ...override.budget };
    }
    if (override.scope) {
      result.scope = {
        allowedDirectories:
          override.scope.allowedDirectories ?? result.scope.allowedDirectories,
        blockedCommands: override.scope.blockedCommands
          ? [...result.scope.blockedCommands, ...override.scope.blockedCommands]
          : result.scope.blockedCommands,
        blockedTools: override.scope.blockedTools
          ? [...result.scope.blockedTools, ...override.scope.blockedTools]
          : result.scope.blockedTools,
      };
    }
    if (override.checkpoints) {
      result.checkpoints = { ...result.checkpoints, ...override.checkpoints };
    }
    if (override.loop) {
      result.loop = { ...result.loop, ...override.loop };
    }
  }

  return result;
}

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
```

**Step 4: Run tests**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/core/src/services/harnessConfig.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/services/harnessConfig.ts packages/core/src/services/harnessConfig.test.ts
git commit -m "feat: add HarnessConfig types with layered merge and duration parser"
```

---

### Task 3: Budget Enforcer Service

**Files:**

- Create: `packages/core/src/services/budgetEnforcerService.ts`
- Create: `packages/core/src/services/budgetEnforcerService.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/core/src/services/budgetEnforcerService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BudgetEnforcerService,
  BudgetStatus,
} from './budgetEnforcerService.js';
import {
  DEFAULT_HARNESS_CONFIG,
  type HarnessBudgetConfig,
} from './harnessConfig.js';

describe('BudgetEnforcerService', () => {
  let service: BudgetEnforcerService;
  const budgetConfig: HarnessBudgetConfig = {
    maxTurns: 10,
    maxDuration: '1h',
    warningThreshold: 0.8,
    checkpointThreshold: 0.95,
  };

  beforeEach(() => {
    service = new BudgetEnforcerService(budgetConfig);
  });

  it('starts with zero usage', () => {
    const status = service.getStatus();
    expect(status.turnsUsed).toBe(0);
    expect(status.level).toBe('ok');
  });

  it('increments turns', () => {
    service.recordTurn();
    expect(service.getStatus().turnsUsed).toBe(1);
  });

  it('returns warning at 80% turns', () => {
    for (let i = 0; i < 8; i++) service.recordTurn();
    expect(service.getStatus().level).toBe('warning');
  });

  it('returns checkpoint at 95% turns', () => {
    for (let i = 0; i < 10; i++) service.recordTurn();
    expect(service.getStatus().level).toBe('checkpoint');
  });

  it('returns exceeded at 100% turns', () => {
    for (let i = 0; i < 11; i++) service.recordTurn();
    expect(service.getStatus().level).toBe('exceeded');
  });

  it('generates warning message', () => {
    for (let i = 0; i < 8; i++) service.recordTurn();
    const msg = service.getWarningMessage();
    expect(msg).toContain('80%');
  });

  it('returns null message when under threshold', () => {
    expect(service.getWarningMessage()).toBeNull();
  });

  it('resets usage', () => {
    for (let i = 0; i < 5; i++) service.recordTurn();
    service.reset();
    expect(service.getStatus().turnsUsed).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/core/src/services/budgetEnforcerService.test.ts`

**Step 3: Write BudgetEnforcerService**

```typescript
// packages/core/src/services/budgetEnforcerService.ts
import { type HarnessBudgetConfig } from './harnessConfig.js';
import { parseDuration } from './harnessConfig.js';

export type BudgetLevel = 'ok' | 'warning' | 'checkpoint' | 'exceeded';

export interface BudgetStatus {
  turnsUsed: number;
  turnsMax: number;
  elapsedMs: number;
  maxDurationMs: number;
  level: BudgetLevel;
  turnPercent: number;
  timePercent: number;
}

export class BudgetEnforcerService {
  private config: HarnessBudgetConfig;
  private turnsUsed = 0;
  private startTime: number;
  private maxDurationMs: number;

  constructor(config: HarnessBudgetConfig) {
    this.config = config;
    this.startTime = Date.now();
    this.maxDurationMs = parseDuration(config.maxDuration) ?? 60 * 60 * 1000;
  }

  recordTurn(): void {
    this.turnsUsed++;
  }

  getStatus(): BudgetStatus {
    const elapsedMs = Date.now() - this.startTime;
    const turnPercent =
      this.config.maxTurns > 0 ? this.turnsUsed / this.config.maxTurns : 0;
    const timePercent =
      this.maxDurationMs > 0 ? elapsedMs / this.maxDurationMs : 0;

    const maxPercent = Math.max(turnPercent, timePercent);

    let level: BudgetLevel;
    if (maxPercent >= 1.0) {
      level = 'exceeded';
    } else if (maxPercent >= this.config.checkpointThreshold) {
      level = 'checkpoint';
    } else if (maxPercent >= this.config.warningThreshold) {
      level = 'warning';
    } else {
      level = 'ok';
    }

    return {
      turnsUsed: this.turnsUsed,
      turnsMax: this.config.maxTurns,
      elapsedMs,
      maxDurationMs: this.maxDurationMs,
      level,
      turnPercent,
      timePercent,
    };
  }

  getWarningMessage(): string | null {
    const status = this.getStatus();
    const percent = Math.round(
      Math.max(status.turnPercent, status.timePercent) * 100,
    );

    switch (status.level) {
      case 'warning':
        return `Budget warning: ${percent}% consumed (${status.turnsUsed}/${status.turnsMax} turns). Plan to wrap up.`;
      case 'checkpoint':
        return `Budget critical: ${percent}% consumed (${status.turnsUsed}/${status.turnsMax} turns). Pausing for review.`;
      case 'exceeded':
        return `Budget exceeded: ${percent}% consumed (${status.turnsUsed}/${status.turnsMax} turns). Summarize state and stop.`;
      default:
        return null;
    }
  }

  shouldPause(): boolean {
    return this.getStatus().level === 'checkpoint';
  }

  shouldStop(): boolean {
    return this.getStatus().level === 'exceeded';
  }

  reset(): void {
    this.turnsUsed = 0;
    this.startTime = Date.now();
  }
}
```

**Step 4: Run tests**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/core/src/services/budgetEnforcerService.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/services/budgetEnforcerService.ts packages/core/src/services/budgetEnforcerService.test.ts
git commit -m "feat: add BudgetEnforcerService with graduated warning levels"
```

---

### Task 4: Scope Enforcer Service

**Files:**

- Create: `packages/core/src/services/scopeEnforcerService.ts`
- Create: `packages/core/src/services/scopeEnforcerService.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/core/src/services/scopeEnforcerService.test.ts
import { describe, it, expect } from 'vitest';
import { ScopeEnforcerService } from './scopeEnforcerService.js';
import type { HarnessScopeConfig } from './harnessConfig.js';

describe('ScopeEnforcerService', () => {
  const config: HarnessScopeConfig = {
    allowedDirectories: ['/home/user/project/src', '/home/user/project/tests'],
    blockedCommands: ['rm -rf /', 'git push --force'],
    blockedTools: ['dangerous_tool'],
  };

  let service: ScopeEnforcerService;

  beforeEach(() => {
    service = new ScopeEnforcerService(config, '/home/user/project');
  });

  it('allows paths within allowed directories', () => {
    expect(service.isPathAllowed('/home/user/project/src/main.ts')).toBe(true);
  });

  it('blocks paths outside allowed directories', () => {
    expect(service.isPathAllowed('/etc/passwd')).toBe(false);
  });

  it('allows any path when allowedDirectories is empty', () => {
    const openService = new ScopeEnforcerService(
      { ...config, allowedDirectories: [] },
      '/home/user/project',
    );
    expect(openService.isPathAllowed('/anywhere/file.ts')).toBe(true);
  });

  it('blocks commands matching blocklist', () => {
    expect(service.isCommandAllowed('rm -rf /')).toBe(false);
    expect(service.isCommandAllowed('git push --force origin main')).toBe(
      false,
    );
  });

  it('allows commands not on blocklist', () => {
    expect(service.isCommandAllowed('npm test')).toBe(true);
  });

  it('blocks tools on blocklist', () => {
    expect(service.isToolAllowed('dangerous_tool')).toBe(false);
  });

  it('allows tools not on blocklist', () => {
    expect(service.isToolAllowed('read_file')).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/core/src/services/scopeEnforcerService.test.ts`

**Step 3: Write ScopeEnforcerService**

```typescript
// packages/core/src/services/scopeEnforcerService.ts
import * as path from 'node:path';
import type { HarnessScopeConfig } from './harnessConfig.js';

export class ScopeEnforcerService {
  private config: HarnessScopeConfig;
  private cwd: string;
  private resolvedAllowedDirs: string[];

  constructor(config: HarnessScopeConfig, cwd: string) {
    this.config = config;
    this.cwd = cwd;
    this.resolvedAllowedDirs = config.allowedDirectories.map((d) =>
      path.resolve(cwd, d),
    );
  }

  isPathAllowed(filePath: string): boolean {
    if (this.resolvedAllowedDirs.length === 0) return true;

    const resolved = path.resolve(filePath);
    return this.resolvedAllowedDirs.some(
      (dir) => resolved === dir || resolved.startsWith(dir + path.sep),
    );
  }

  isCommandAllowed(command: string): boolean {
    const normalized = command.trim();
    return !this.config.blockedCommands.some((blocked) =>
      normalized.includes(blocked),
    );
  }

  isToolAllowed(toolName: string): boolean {
    return !this.config.blockedTools.includes(toolName);
  }

  getViolationMessage(
    type: 'path' | 'command' | 'tool',
    value: string,
  ): string {
    switch (type) {
      case 'path':
        return `Scope violation: path "${value}" is outside allowed directories [${this.resolvedAllowedDirs.join(', ')}]`;
      case 'command':
        return `Scope violation: command contains blocked pattern in "${value}"`;
      case 'tool':
        return `Scope violation: tool "${value}" is blocked by harness configuration`;
    }
  }
}
```

**Step 4: Run tests**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/core/src/services/scopeEnforcerService.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/services/scopeEnforcerService.ts packages/core/src/services/scopeEnforcerService.test.ts
git commit -m "feat: add ScopeEnforcerService for directory/command/tool constraints"
```

---

### Task 5: Cron Tool Names and Declarations

**Files:**

- Modify: `packages/core/src/tools/definitions/base-declarations.ts` — add cron
  tool name constants
- Modify: `packages/core/src/tools/tool-names.ts` — export cron tool names
- Modify: `packages/core/src/tools/definitions/model-family-sets/gemini-3.ts` —
  add cron tool declarations
- Modify: `packages/core/src/tools/definitions/types.ts` — add cron tools to
  CoreToolSet

**Step 1: Add cron tool name constants to base-declarations.ts**

Add after the existing `EXIT_PLAN_MODE_TOOL_NAME` constant block:

```typescript
// -- cron_create --
export const CRON_CREATE_TOOL_NAME = 'cron_create';
export const CRON_CREATE_PARAM_CRON = 'cron_expression';
export const CRON_CREATE_PARAM_PROMPT = 'prompt';
export const CRON_CREATE_PARAM_RECURRING = 'recurring';
export const CRON_CREATE_PARAM_PERSISTENT = 'persistent';

// -- cron_list --
export const CRON_LIST_TOOL_NAME = 'cron_list';

// -- cron_delete --
export const CRON_DELETE_TOOL_NAME = 'cron_delete';
export const CRON_DELETE_PARAM_TASK_ID = 'task_id';
```

**Step 2: Export from tool-names.ts**

Add the cron tool names to the import from `./definitions/coreTools.js` and the
re-export block. Also add them to `ALL_BUILTIN_TOOL_NAMES`.

**Step 3: Add FunctionDeclarations to gemini-3.ts model family set**

Add cron tool declarations in the CoreToolSet for gemini-3:

```typescript
cron_create: {
  name: CRON_CREATE_TOOL_NAME,
  description: 'Schedule a recurring or one-shot task. The task prompt will be executed on the specified schedule.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      [CRON_CREATE_PARAM_CRON]: {
        type: SchemaType.STRING,
        description: 'A 5-field cron expression (minute hour day-of-month month day-of-week). Example: "*/5 * * * *" for every 5 minutes.',
      },
      [CRON_CREATE_PARAM_PROMPT]: {
        type: SchemaType.STRING,
        description: 'The prompt to execute on each scheduled fire.',
      },
      [CRON_CREATE_PARAM_RECURRING]: {
        type: SchemaType.BOOLEAN,
        description: 'If true (default), the task repeats. If false, it fires once and deletes itself.',
      },
      [CRON_CREATE_PARAM_PERSISTENT]: {
        type: SchemaType.BOOLEAN,
        description: 'If true, the task maintains context across iterations. Default false.',
      },
    },
    required: [CRON_CREATE_PARAM_CRON, CRON_CREATE_PARAM_PROMPT],
  },
},
cron_list: {
  name: CRON_LIST_TOOL_NAME,
  description: 'List all scheduled tasks with their IDs, schedules, and prompts.',
  parameters: { type: SchemaType.OBJECT, properties: {} },
},
cron_delete: {
  name: CRON_DELETE_TOOL_NAME,
  description: 'Cancel a scheduled task by its ID.',
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      [CRON_DELETE_PARAM_TASK_ID]: {
        type: SchemaType.STRING,
        description: 'The 8-character task ID to cancel.',
      },
    },
    required: [CRON_DELETE_PARAM_TASK_ID],
  },
},
```

**Step 4: Update CoreToolSet type in types.ts**

Add to the `CoreToolSet` interface:

```typescript
cron_create: FunctionDeclaration;
cron_list: FunctionDeclaration;
cron_delete: FunctionDeclaration;
```

**Step 5: Run existing tests to ensure nothing breaks**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/core/src/tools/definitions/`
Expected: PASS (or fix any snapshot issues)

**Step 6: Commit**

```bash
git add packages/core/src/tools/definitions/ packages/core/src/tools/tool-names.ts
git commit -m "feat: add CronCreate, CronList, CronDelete tool declarations"
```

---

### Task 6: Cron Tool Implementations

**Files:**

- Create: `packages/core/src/tools/cron.ts`
- Create: `packages/core/src/tools/cron.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/core/src/tools/cron.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCronCreate, handleCronList, handleCronDelete } from './cron.js';
import { CronService } from '../services/cronService.js';

describe('cron tool handlers', () => {
  let cronService: CronService;

  beforeEach(() => {
    cronService = new CronService({
      maxConcurrent: 5,
      maxDurationMs: 86400000,
      enabled: true,
    });
  });

  describe('handleCronCreate', () => {
    it('creates a task and returns its ID', () => {
      const result = handleCronCreate(cronService, {
        cron_expression: '*/5 * * * *',
        prompt: 'check build',
      });
      expect(result.success).toBe(true);
      expect(result.taskId).toBeDefined();
    });

    it('rejects invalid cron expression', () => {
      const result = handleCronCreate(cronService, {
        cron_expression: 'bad',
        prompt: 'test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid cron');
    });
  });

  describe('handleCronList', () => {
    it('returns formatted task list', () => {
      cronService.createTask({ cron: '*/5 * * * *', prompt: 'task 1' });
      const result = handleCronList(cronService);
      expect(result).toContain('task 1');
    });
  });

  describe('handleCronDelete', () => {
    it('deletes an existing task', () => {
      const task = cronService.createTask({
        cron: '*/5 * * * *',
        prompt: 'test',
      })!;
      const result = handleCronDelete(cronService, { task_id: task.id });
      expect(result.success).toBe(true);
    });

    it('returns error for non-existent task', () => {
      const result = handleCronDelete(cronService, { task_id: 'nope' });
      expect(result.success).toBe(false);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/core/src/tools/cron.test.ts`

**Step 3: Write cron tool handlers**

```typescript
// packages/core/src/tools/cron.ts
import { CronService, parseCronExpression } from '../services/cronService.js';

export interface CronCreateArgs {
  cron_expression: string;
  prompt: string;
  recurring?: boolean;
  persistent?: boolean;
}

export interface CronCreateResult {
  success: boolean;
  taskId?: string;
  schedule?: string;
  error?: string;
}

export function handleCronCreate(
  cronService: CronService,
  args: CronCreateArgs,
): CronCreateResult {
  const parsed = parseCronExpression(args.cron_expression);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid cron expression: "${args.cron_expression}". Use 5-field format: "minute hour day-of-month month day-of-week".`,
    };
  }

  const task = cronService.createTask({
    cron: args.cron_expression,
    prompt: args.prompt,
    recurring: args.recurring ?? true,
    persistent: args.persistent ?? false,
  });

  if (!task) {
    return {
      success: false,
      error: 'Maximum number of scheduled tasks reached.',
    };
  }

  return {
    success: true,
    taskId: task.id,
    schedule: args.cron_expression,
  };
}

export function handleCronList(cronService: CronService): string {
  return cronService.formatTaskList();
}

export interface CronDeleteArgs {
  task_id: string;
}

export interface CronDeleteResult {
  success: boolean;
  error?: string;
}

export function handleCronDelete(
  cronService: CronService,
  args: CronDeleteArgs,
): CronDeleteResult {
  const deleted = cronService.deleteTask(args.task_id);
  if (!deleted) {
    return {
      success: false,
      error: `No task found with ID "${args.task_id}".`,
    };
  }
  return { success: true };
}
```

**Step 4: Run tests**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/core/src/tools/cron.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/core/src/tools/cron.ts packages/core/src/tools/cron.test.ts
git commit -m "feat: add cron tool handler implementations"
```

---

### Task 7: /loop Slash Command

**Files:**

- Create: `packages/cli/src/ui/commands/loopCommand.ts`
- Create: `packages/cli/src/ui/commands/loopCommand.test.ts`

**Step 1: Write failing tests**

```typescript
// packages/cli/src/ui/commands/loopCommand.test.ts
import { describe, it, expect } from 'vitest';
import { parseLoopArgs } from './loopCommand.js';

describe('parseLoopArgs', () => {
  it('parses leading interval', () => {
    const result = parseLoopArgs('5m check the build');
    expect(result.interval).toBe('5m');
    expect(result.prompt).toBe('check the build');
  });

  it('parses trailing every clause', () => {
    const result = parseLoopArgs('check the build every 2h');
    expect(result.interval).toBe('2h');
    expect(result.prompt).toBe('check the build');
  });

  it('defaults interval when none specified', () => {
    const result = parseLoopArgs('check the build');
    expect(result.interval).toBeUndefined();
    expect(result.prompt).toBe('check the build');
  });

  it('handles empty input', () => {
    const result = parseLoopArgs('');
    expect(result.prompt).toBe('');
  });
});
```

**Step 2: Run test to verify it fails**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/cli/src/ui/commands/loopCommand.test.ts`

**Step 3: Write the /loop command**

```typescript
// packages/cli/src/ui/commands/loopCommand.ts
import {
  type CommandContext,
  CommandKind,
  type SlashCommand,
} from './types.js';
import { MessageType } from '../types.js';
import {
  parseInterval,
  intervalToCron,
  type CronService,
} from '@google/gemini-cli-core';

export interface ParsedLoopArgs {
  interval: string | undefined;
  prompt: string;
}

export function parseLoopArgs(input: string): ParsedLoopArgs {
  const trimmed = input.trim();
  if (!trimmed) return { interval: undefined, prompt: '' };

  // Leading interval: "5m check the build"
  const leadingMatch = trimmed.match(/^(\d+[smhd])\s+(.+)$/i);
  if (leadingMatch) {
    return { interval: leadingMatch[1], prompt: leadingMatch[2] };
  }

  // Trailing "every" clause: "check the build every 2h"
  const trailingMatch = trimmed.match(/^(.+?)\s+every\s+(\d+[smhd])$/i);
  if (trailingMatch) {
    return { interval: trailingMatch[2], prompt: trailingMatch[1] };
  }

  return { interval: undefined, prompt: trimmed };
}

const loopStartAction = async (
  context: CommandContext,
  args: string,
): Promise<void> => {
  const config = context.services.config;
  if (!config) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Configuration not available.',
    });
    return;
  }

  const cronService = config.getCronService?.();
  if (!cronService) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Scheduled tasks are not enabled.',
    });
    return;
  }

  const trimmed = args.trim();

  // No args → list tasks
  if (!trimmed) {
    const list = cronService.formatTaskList();
    context.ui.addItem({ type: MessageType.INFO, text: list });
    return;
  }

  const parsed = parseLoopArgs(trimmed);
  if (!parsed.prompt) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Usage: /loop [interval] <prompt>',
    });
    return;
  }

  const interval = parseInterval(parsed.interval);
  if (!interval) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: `Invalid interval: "${parsed.interval}". Use: 30s, 5m, 2h, 1d`,
    });
    return;
  }

  const cron = intervalToCron(interval);
  const task = cronService.createTask({
    cron,
    prompt: parsed.prompt,
    recurring: true,
    persistent: false,
  });

  if (!task) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Maximum number of scheduled tasks reached.',
    });
    return;
  }

  context.ui.addItem({
    type: MessageType.INFO,
    text: `Scheduled loop ${task.id}: "${parsed.prompt}" (every ${interval.minutes}m)\nUse /loop to list, /loop cancel ${task.id} to stop.`,
  });
};

const loopListAction = async (context: CommandContext): Promise<void> => {
  const cronService = context.services.config?.getCronService?.();
  if (!cronService) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Scheduled tasks are not enabled.',
    });
    return;
  }
  context.ui.addItem({
    type: MessageType.INFO,
    text: cronService.formatTaskList(),
  });
};

const loopCancelAction = async (
  context: CommandContext,
  args: string,
): Promise<void> => {
  const cronService = context.services.config?.getCronService?.();
  if (!cronService) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Scheduled tasks are not enabled.',
    });
    return;
  }

  const taskId = args.trim();
  if (!taskId) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Usage: /loop cancel <task-id>',
    });
    return;
  }

  if (cronService.deleteTask(taskId)) {
    context.ui.addItem({
      type: MessageType.INFO,
      text: `Cancelled loop ${taskId}.`,
    });
  } else {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: `No task found with ID "${taskId}".`,
    });
  }
};

export const loopCommand: SlashCommand = {
  name: 'loop',
  description: 'Schedule recurring tasks (/loop [interval] <prompt>)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'list',
      description: 'List all scheduled loops',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: loopListAction,
    },
    {
      name: 'cancel',
      description: 'Cancel a scheduled loop by ID',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: loopCancelAction,
    },
  ],
  action: loopStartAction,
};
```

**Step 4: Run tests**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/cli/src/ui/commands/loopCommand.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/cli/src/ui/commands/loopCommand.ts packages/cli/src/ui/commands/loopCommand.test.ts
git commit -m "feat: add /loop slash command for scheduled recurring tasks"
```

---

### Task 8: Wire Everything Together

**Files:**

- Modify: `packages/core/src/index.ts` — export new services
- Modify: `packages/core/src/config/config.ts` — add CronService,
  BudgetEnforcer, ScopeEnforcer to Config
- Modify: `packages/cli/src/services/BuiltinCommandLoader.ts` — register /loop
  command
- Modify: `packages/cli/src/config/config.ts` — pass harness config through
- Modify: `packages/core/src/tools/tool-names.ts` — add cron tools to
  ALL_BUILTIN_TOOL_NAMES

**Step 1: Add exports to core/index.ts**

After the existing service exports (around line 251), add:

```typescript
export * from './services/cronService.js';
export * from './services/harnessConfig.js';
export * from './services/budgetEnforcerService.js';
export * from './services/scopeEnforcerService.js';
export * from './tools/cron.js';
```

**Step 2: Add CronService to core Config class**

Read `packages/core/src/config/config.ts` and add:

- A `cronService` private field
- A `getCronService()` getter
- A `harnessConfig` field
- A `budgetEnforcer` field
- A `scopeEnforcer` field
- Initialize them in the constructor using the config options

Add to the `ConfigOptions` interface:

```typescript
harness?: Partial<HarnessConfig>;
```

Add to the `Config` class:

```typescript
private cronService: CronService | null = null;
private budgetEnforcer: BudgetEnforcerService | null = null;
private scopeEnforcer: ScopeEnforcerService | null = null;
private harnessConfig: HarnessConfig;

// In constructor:
this.harnessConfig = mergeHarnessConfig(options.harness);
if (this.harnessConfig.loop.enabled) {
  this.cronService = new CronService({
    maxConcurrent: this.harnessConfig.loop.maxConcurrent,
    maxDurationMs: parseDuration(this.harnessConfig.loop.maxDuration) ?? 3 * 24 * 60 * 60 * 1000,
    enabled: true,
  });
  this.cronService.start();
}
this.budgetEnforcer = new BudgetEnforcerService(this.harnessConfig.budget);
this.scopeEnforcer = new ScopeEnforcerService(this.harnessConfig.scope, options.cwd ?? process.cwd());

// Getters:
getCronService(): CronService | null { return this.cronService; }
getBudgetEnforcer(): BudgetEnforcerService | null { return this.budgetEnforcer; }
getScopeEnforcer(): ScopeEnforcerService | null { return this.scopeEnforcer; }
getHarnessConfig(): HarnessConfig { return this.harnessConfig; }
```

**Step 3: Register /loop in BuiltinCommandLoader**

In `packages/cli/src/services/BuiltinCommandLoader.ts`:

Add import:

```typescript
import { loopCommand } from '../ui/commands/loopCommand.js';
```

Add to `allDefinitions` array (after bgCommand):

```typescript
...(this.config?.getCronService?.() ? [loopCommand] : []),
```

**Step 4: Wire harness settings through cli/config/config.ts**

In `packages/cli/src/config/config.ts`, in the `loadCliConfig` function, pass
harness settings to the Config constructor:

```typescript
harness: settings.harness,
```

**Step 5: Run full test suite**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/core/src/services/cronService.test.ts packages/core/src/services/harnessConfig.test.ts packages/core/src/services/budgetEnforcerService.test.ts packages/core/src/services/scopeEnforcerService.test.ts packages/core/src/tools/cron.test.ts packages/cli/src/ui/commands/loopCommand.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/config/config.ts packages/cli/src/services/BuiltinCommandLoader.ts packages/cli/src/config/config.ts packages/core/src/tools/tool-names.ts
git commit -m "feat: wire harness engineering and /loop into Config and CLI"
```

---

### Task 9: Add Settings Schema for Harness

**Files:**

- Modify: `packages/cli/src/config/settingsSchema.ts` — add harness settings
  definitions
- Modify: `packages/cli/src/config/settings.ts` — add harness to MergedSettings
  type

**Step 1: Add harness settings to settingsSchema.ts**

Add a new `harness` category with nested properties matching the `HarnessConfig`
type. Follow the existing pattern for nested settings like `tools` or
`security`.

**Step 2: Add harness to the MergedSettings type in settings.ts**

```typescript
harness?: Partial<HarnessConfig>;
```

**Step 3: Run settings tests**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/cli/src/config/settings`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/cli/src/config/settingsSchema.ts packages/cli/src/config/settings.ts
git commit -m "feat: add harness settings schema for settings.json configuration"
```

---

### Task 10: Add CLI Flags for Harness Overrides

**Files:**

- Modify: `packages/cli/src/config/config.ts` — add --max-turns, --max-duration,
  --checkpoint-every flags

**Step 1: Add CLI flags to yargs config**

In `parseArguments`, add:

```typescript
.option('max-turns', {
  type: 'number',
  nargs: 1,
  description: 'Maximum number of turns before stopping (harness budget)',
})
.option('max-duration', {
  type: 'string',
  nargs: 1,
  description: 'Maximum session duration before stopping, e.g., "30m", "1h" (harness budget)',
})
.option('checkpoint-every', {
  type: 'number',
  nargs: 1,
  description: 'Pause for review every N turns (harness checkpoint)',
})
```

**Step 2: Add to CliArgs interface**

```typescript
maxTurns: number | undefined;
maxDuration: string | undefined;
checkpointEvery: number | undefined;
```

**Step 3: Merge CLI overrides in loadCliConfig**

When building the harness config, apply CLI flag overrides on top of settings:

```typescript
const harnessOverrides: Partial<HarnessConfig> = {};
if (argv.maxTurns)
  harnessOverrides.budget = {
    ...harnessOverrides.budget,
    maxTurns: argv.maxTurns,
  };
if (argv.maxDuration)
  harnessOverrides.budget = {
    ...harnessOverrides.budget,
    maxDuration: argv.maxDuration,
  };
if (argv.checkpointEvery != null)
  harnessOverrides.checkpoints = {
    ...harnessOverrides.checkpoints,
    every: argv.checkpointEvery,
  };
```

Pass to Config constructor:
`harness: mergeHarnessConfig(settings.harness, harnessOverrides)`

**Step 4: Run config tests**

Run:
`cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run packages/cli/src/config/`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/cli/src/config/config.ts
git commit -m "feat: add --max-turns, --max-duration, --checkpoint-every CLI flags"
```

---

### Task 11: Integration — Cron Task Execution via BackgroundTaskService

**Files:**

- Modify: `packages/cli/src/ui/commands/loopCommand.ts` — wire CronService
  'task-due' events to BackgroundTaskService execution

**Step 1: Add event listener for task-due**

In `loopCommand.ts`, add a function that registers a listener on the
CronService's `task-due` event. When a task fires, it creates a background task
and executes it using the same pattern as `/bg`:

```typescript
export function registerCronExecutor(
  cronService: CronService,
  context: CommandContext,
): void {
  cronService.on('task-due', async (task) => {
    // Execute the prompt using the bg infrastructure
    const bgService = getBackgroundTaskService();
    const bgId = bgService.createTask(`[loop:${task.id}] ${task.prompt}`);
    if (!bgId) return;
    await executeBackgroundTask(context, bgId, task.prompt);
  });
}
```

**Step 2: Register the executor when the session starts**

This should be called from the main app initialization when both the CronService
and the session context are available.

**Step 3: Run integration test manually**

Start gemini CLI, run `/loop 1m echo test`, verify it fires after ~1 minute.

**Step 4: Commit**

```bash
git add packages/cli/src/ui/commands/loopCommand.ts
git commit -m "feat: wire cron task-due events to background task execution"
```

---

### Task 12: Final Verification and Cleanup

**Step 1: Run full test suite**

```bash
cd /usr/local/google/home/ramonqu/gemini-cli && npx vitest run
```

Fix any failures.

**Step 2: Verify /loop command works end-to-end**

```bash
cd /usr/local/google/home/ramonqu/gemini-cli && npm run build && node dist/gemini.js
# Then type: /loop 1m what time is it
# Then type: /loop
# Then type: /loop cancel <id>
```

**Step 3: Verify harness flags work**

```bash
node dist/gemini.js --max-turns 5 --checkpoint-every 3
```

**Step 4: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: address test failures and integration issues"
```
