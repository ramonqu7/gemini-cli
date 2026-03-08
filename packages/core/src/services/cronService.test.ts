/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseInterval,
  intervalToCron,
  parseCronExpression,
  CronService,
} from './cronService.js';

describe('parseInterval', () => {
  it('parses minutes', () => {
    expect(parseInterval('5m')).toEqual({ minutes: 5 });
    expect(parseInterval('1m')).toEqual({ minutes: 1 });
    expect(parseInterval('120m')).toEqual({ minutes: 120 });
  });

  it('parses hours', () => {
    expect(parseInterval('2h')).toEqual({ minutes: 120 });
    expect(parseInterval('1h')).toEqual({ minutes: 60 });
    expect(parseInterval('24h')).toEqual({ minutes: 1440 });
  });

  it('parses seconds and rounds up to at least 1 minute', () => {
    expect(parseInterval('30s')).toEqual({ minutes: 1 });
    expect(parseInterval('90s')).toEqual({ minutes: 2 });
    expect(parseInterval('60s')).toEqual({ minutes: 1 });
    expect(parseInterval('1s')).toEqual({ minutes: 1 });
    expect(parseInterval('121s')).toEqual({ minutes: 3 });
  });

  it('parses days', () => {
    expect(parseInterval('1d')).toEqual({ minutes: 1440 });
    expect(parseInterval('2d')).toEqual({ minutes: 2880 });
  });

  it('returns default for undefined', () => {
    expect(parseInterval(undefined)).toEqual({ minutes: 10 });
  });

  it('returns null for invalid input', () => {
    expect(parseInterval('')).toBeNull();
    expect(parseInterval('abc')).toBeNull();
    expect(parseInterval('5x')).toBeNull();
    expect(parseInterval('m5')).toBeNull();
    expect(parseInterval('-5m')).toBeNull();
    expect(parseInterval('0m')).toBeNull();
  });

  it('handles whitespace around input', () => {
    expect(parseInterval('  5m  ')).toEqual({ minutes: 5 });
  });

  it('is case-insensitive for unit suffix', () => {
    expect(parseInterval('5M')).toEqual({ minutes: 5 });
    expect(parseInterval('2H')).toEqual({ minutes: 120 });
    expect(parseInterval('1D')).toEqual({ minutes: 1440 });
    expect(parseInterval('30S')).toEqual({ minutes: 1 });
  });
});

describe('intervalToCron', () => {
  it('converts minute intervals to cron', () => {
    expect(intervalToCron({ minutes: 5 })).toBe('*/5 * * * *');
    expect(intervalToCron({ minutes: 15 })).toBe('*/15 * * * *');
    expect(intervalToCron({ minutes: 30 })).toBe('*/30 * * * *');
    expect(intervalToCron({ minutes: 1 })).toBe('*/1 * * * *');
  });

  it('converts hourly intervals to cron', () => {
    expect(intervalToCron({ minutes: 60 })).toBe('0 */1 * * *');
    expect(intervalToCron({ minutes: 120 })).toBe('0 */2 * * *');
    expect(intervalToCron({ minutes: 360 })).toBe('0 */6 * * *');
  });

  it('converts daily interval to cron', () => {
    expect(intervalToCron({ minutes: 1440 })).toBe('0 0 * * *');
  });

  it('converts multi-day intervals to daily cron', () => {
    expect(intervalToCron({ minutes: 2880 })).toBe('0 0 * * *');
  });
});

describe('parseCronExpression', () => {
  it('parses valid 5-field cron expressions', () => {
    expect(parseCronExpression('*/5 * * * *')).toEqual({
      minute: '*/5',
      hour: '*',
      dom: '*',
      month: '*',
      dow: '*',
    });

    expect(parseCronExpression('0 */2 * * *')).toEqual({
      minute: '0',
      hour: '*/2',
      dom: '*',
      month: '*',
      dow: '*',
    });

    expect(parseCronExpression('0 0 * * *')).toEqual({
      minute: '0',
      hour: '0',
      dom: '*',
      month: '*',
      dow: '*',
    });
  });

  it('returns null for invalid expressions', () => {
    expect(parseCronExpression('')).toBeNull();
    expect(parseCronExpression('* * *')).toBeNull();
    expect(parseCronExpression('* * * * * *')).toBeNull();
    expect(parseCronExpression('abc def ghi jkl mno')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseCronExpression(null as unknown as string)).toBeNull();
    expect(parseCronExpression(undefined as unknown as string)).toBeNull();
  });

  it('handles extra whitespace', () => {
    expect(parseCronExpression('  */5  *  *  *  *  ')).toEqual({
      minute: '*/5',
      hour: '*',
      dom: '*',
      month: '*',
      dow: '*',
    });
  });
});

describe('CronService', () => {
  let service: CronService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new CronService();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  describe('createTask', () => {
    it('creates a task with default options', () => {
      const task = service.createTask({
        cron: '*/5 * * * *',
        prompt: 'check status',
      });

      expect(task).not.toBeNull();
      expect(task!.id).toHaveLength(8);
      expect(task!.cron).toBe('*/5 * * * *');
      expect(task!.prompt).toBe('check status');
      expect(task!.recurring).toBe(true);
      expect(task!.persistent).toBe(false);
      expect(task!.status).toBe('active');
      expect(task!.fireCount).toBe(0);
      expect(task!.lastFiredAt).toBeUndefined();
      expect(task!.expiresAt).toBeGreaterThan(task!.createdAt);
    });

    it('creates a task with explicit options', () => {
      const task = service.createTask({
        cron: '0 0 * * *',
        prompt: 'daily report',
        recurring: false,
        persistent: true,
      });

      expect(task).not.toBeNull();
      expect(task!.recurring).toBe(false);
      expect(task!.persistent).toBe(true);
    });

    it('returns null when at max concurrent tasks', () => {
      const svc = new CronService({ maxConcurrent: 2 });

      const t1 = svc.createTask({ cron: '*/5 * * * *', prompt: 'task 1' });
      const t2 = svc.createTask({ cron: '*/5 * * * *', prompt: 'task 2' });
      const t3 = svc.createTask({ cron: '*/5 * * * *', prompt: 'task 3' });

      expect(t1).not.toBeNull();
      expect(t2).not.toBeNull();
      expect(t3).toBeNull();
    });

    it('returns null when service is disabled', () => {
      const svc = new CronService({ enabled: false });
      const task = svc.createTask({
        cron: '*/5 * * * *',
        prompt: 'test',
      });

      expect(task).toBeNull();
    });

    it('returns null for invalid cron expression', () => {
      const task = service.createTask({
        cron: 'not-a-cron',
        prompt: 'test',
      });

      expect(task).toBeNull();
    });

    it('emits task-created event', () => {
      const handler = vi.fn();
      service.on('task-created', handler);

      const task = service.createTask({
        cron: '*/5 * * * *',
        prompt: 'test',
      });

      expect(handler).toHaveBeenCalledWith(task);
    });
  });

  describe('deleteTask', () => {
    it('deletes an existing task', () => {
      const task = service.createTask({
        cron: '*/5 * * * *',
        prompt: 'test',
      });

      expect(service.deleteTask(task!.id)).toBe(true);
      expect(service.getTask(task!.id)).toBeUndefined();
    });

    it('returns false for non-existent task', () => {
      expect(service.deleteTask('nonexistent')).toBe(false);
    });

    it('emits task-deleted event', () => {
      const handler = vi.fn();
      service.on('task-deleted', handler);

      const task = service.createTask({
        cron: '*/5 * * * *',
        prompt: 'test',
      });
      service.deleteTask(task!.id);

      expect(handler).toHaveBeenCalledWith(task);
    });
  });

  describe('getTask', () => {
    it('returns a task by ID', () => {
      const task = service.createTask({
        cron: '*/5 * * * *',
        prompt: 'test',
      });

      expect(service.getTask(task!.id)).toBe(task);
    });

    it('returns undefined for non-existent ID', () => {
      expect(service.getTask('nonexistent')).toBeUndefined();
    });
  });

  describe('getAllTasks', () => {
    it('returns all tasks', () => {
      service.createTask({ cron: '*/5 * * * *', prompt: 'task 1' });
      service.createTask({ cron: '*/10 * * * *', prompt: 'task 2' });

      const tasks = service.getAllTasks();
      expect(tasks).toHaveLength(2);
    });

    it('returns empty array when no tasks exist', () => {
      expect(service.getAllTasks()).toEqual([]);
    });
  });

  describe('getActiveTasks', () => {
    it('returns only active tasks', () => {
      service.createTask({ cron: '*/5 * * * *', prompt: 'task 1' });
      service.createTask({ cron: '*/10 * * * *', prompt: 'task 2' });

      const activeTasks = service.getActiveTasks();
      expect(activeTasks).toHaveLength(2);
      expect(activeTasks.every((t) => t.status === 'active')).toBe(true);
    });
  });

  describe('formatTaskList', () => {
    it('formats an empty task list', () => {
      expect(service.formatTaskList()).toBe('No scheduled tasks.');
    });

    it('formats tasks with details', () => {
      service.createTask({
        cron: '*/5 * * * *',
        prompt: 'check server status',
      });
      service.createTask({
        cron: '0 0 * * *',
        prompt: 'daily cleanup',
        recurring: false,
      });

      const output = service.formatTaskList();
      expect(output).toContain('Scheduled Tasks:');
      expect(output).toContain('ACTIVE');
      expect(output).toContain('*/5 * * * *');
      expect(output).toContain('recurring');
      expect(output).toContain('one-shot');
      expect(output).toContain('fired=0');
    });

    it('truncates long prompts', () => {
      const longPrompt = 'a'.repeat(100);
      service.createTask({
        cron: '*/5 * * * *',
        prompt: longPrompt,
      });

      const output = service.formatTaskList();
      expect(output).toContain('...');
      expect(output.length).toBeLessThan(longPrompt.length + 100);
    });
  });

  describe('start and stop', () => {
    it('starts and stops the tick interval', () => {
      service.start();
      // Starting again should be a no-op.
      service.start();
      service.stop();
      // Stopping again should be a no-op.
      service.stop();
    });
  });

  describe('setBusy', () => {
    it('prevents task firing when busy', () => {
      const handler = vi.fn();
      service.on('task-due', handler);

      service.createTask({
        cron: '* * * * *',
        prompt: 'test',
      });

      service.setBusy(true);
      service.start();

      // Advance time enough for multiple ticks.
      vi.advanceTimersByTime(120_000);

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('default config', () => {
    it('uses correct defaults', () => {
      const svc = new CronService();
      // Should allow up to 5 tasks.
      for (let i = 0; i < 5; i++) {
        expect(
          svc.createTask({ cron: '*/5 * * * *', prompt: `task ${i}` }),
        ).not.toBeNull();
      }
      // 6th task should be rejected.
      expect(
        svc.createTask({ cron: '*/5 * * * *', prompt: 'task 5' }),
      ).toBeNull();
    });

    it('sets expiration to maxDurationMs from creation', () => {
      const task = service.createTask({
        cron: '*/5 * * * *',
        prompt: 'test',
      });

      const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
      expect(task!.expiresAt - task!.createdAt).toBe(threeDaysMs);
    });
  });
});
