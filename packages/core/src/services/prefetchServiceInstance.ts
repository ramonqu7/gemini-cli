/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PrefetchService } from './prefetchService.js';

/**
 * Module-level singleton holder for the PrefetchService.
 *
 * This avoids threading the service through every constructor in the
 * tool chain. The instance is set once during client initialization
 * and accessed by tools via `prefetchServiceInstance.get()`.
 */
class PrefetchServiceInstance {
  private instance: PrefetchService | null = null;

  set(service: PrefetchService): void {
    this.instance = service;
  }

  get(): PrefetchService | null {
    return this.instance;
  }

  clear(): void {
    this.instance = null;
  }
}

export const prefetchServiceInstance = new PrefetchServiceInstance();
