/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CronService } from '../services/cronService.js';
import { handleCronCreate, handleCronList, handleCronDelete } from './cron.js';

describe('handleCronCreate', () => {
  let cronService: CronService;

  beforeEach(() => {
    cronService = new CronService({ maxConcurrent: 3 });
  });

  it('creates a task and returns the ID', () => {
    const result = handleCronCreate(cronService, {
      cron_expression: '*/5 * * * *',
      prompt: 'check status',
    });

    expect(result.success).toBe(true);
    expect(result.taskId).toBeDefined();
    expect(result.taskId).toHaveLength(8);
    expect(result.schedule).toBe('*/5 * * * *');
    expect(result.error).toBeUndefined();
  });

  it('rejects an invalid cron expression', () => {
    const result = handleCronCreate(cronService, {
      cron_expression: 'not a cron',
      prompt: 'check status',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid cron expression');
    expect(result.taskId).toBeUndefined();
  });

  it('returns error when max concurrent tasks are reached', () => {
    // Fill up all 3 slots.
    for (let i = 0; i < 3; i++) {
      const r = handleCronCreate(cronService, {
        cron_expression: '0 * * * *',
        prompt: `task ${i}`,
      });
      expect(r.success).toBe(true);
    }

    // The 4th should fail.
    const result = handleCronCreate(cronService, {
      cron_expression: '0 * * * *',
      prompt: 'one too many',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Maximum number of concurrent tasks');
  });

  it('passes recurring and persistent options through', () => {
    const result = handleCronCreate(cronService, {
      cron_expression: '0 0 * * *',
      prompt: 'daily check',
      recurring: false,
      persistent: true,
    });

    expect(result.success).toBe(true);
    const task = cronService.getTask(result.taskId!);
    expect(task).toBeDefined();
    expect(task!.recurring).toBe(false);
    expect(task!.persistent).toBe(true);
  });
});

describe('handleCronList', () => {
  let cronService: CronService;

  beforeEach(() => {
    cronService = new CronService();
  });

  it('returns "No scheduled tasks." when empty', () => {
    const result = handleCronList(cronService);
    expect(result).toBe('No scheduled tasks.');
  });

  it('returns a formatted task list', () => {
    handleCronCreate(cronService, {
      cron_expression: '*/10 * * * *',
      prompt: 'run health check',
    });
    handleCronCreate(cronService, {
      cron_expression: '0 0 * * *',
      prompt: 'daily report',
      recurring: false,
    });

    const result = handleCronList(cronService);
    expect(result).toContain('Scheduled Tasks:');
    expect(result).toContain('run health check');
    expect(result).toContain('daily report');
    expect(result).toContain('ACTIVE');
    expect(result).toContain('recurring');
    expect(result).toContain('one-shot');
  });
});

describe('handleCronDelete', () => {
  let cronService: CronService;

  beforeEach(() => {
    cronService = new CronService();
  });

  it('deletes an existing task', () => {
    const created = handleCronCreate(cronService, {
      cron_expression: '*/5 * * * *',
      prompt: 'check status',
    });

    const result = handleCronDelete(cronService, {
      task_id: created.taskId!,
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(cronService.getTask(created.taskId!)).toBeUndefined();
  });

  it('returns error for a non-existent task', () => {
    const result = handleCronDelete(cronService, {
      task_id: 'nonexistent',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});
