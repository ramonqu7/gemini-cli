/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import { debugLogger } from '../utils/debugLogger.js';

/**
 * Prompt Caching Service.
 *
 * Manages a content hash to detect when the system prompt or GEMINI.md
 * has changed, enabling efficient cache invalidation with Gemini's
 * cached content API.
 *
 * The Gemini API supports caching system instructions and initial context
 * to reduce latency and cost on subsequent requests. This service tracks
 * content changes to know when the cache needs invalidation.
 *
 * Usage with @google/genai SDK:
 * ```typescript
 * const cacheManager = new GoogleAICacheManager(apiKey);
 * const cachedContent = await cacheManager.create({
 *   model: 'gemini-2.0-flash',
 *   systemInstruction: systemPrompt,
 *   contents: [...initialContext],
 *   ttlSeconds: 3600,
 * });
 * // Use cachedContent.name in subsequent requests
 * ```
 */
export class PromptCachingService {
  private contentHash: string | null = null;
  private cachedContentName: string | null = null;
  private lastUpdateTime: number = 0;

  /**
   * Computes a hash of the content to detect changes.
   */
  computeHash(...contents: string[]): string {
    const hash = crypto.createHash('sha256');
    for (const content of contents) {
      hash.update(content);
    }
    return hash.digest('hex');
  }

  /**
   * Checks if the content has changed since last cache creation.
   */
  hasContentChanged(systemPrompt: string, memoryContent: string): boolean {
    const newHash = this.computeHash(systemPrompt, memoryContent);
    if (this.contentHash === null || this.contentHash !== newHash) {
      return true;
    }
    return false;
  }

  /**
   * Updates the cache state after creating a new cached content.
   */
  updateCacheState(
    systemPrompt: string,
    memoryContent: string,
    cachedContentName: string,
  ): void {
    this.contentHash = this.computeHash(systemPrompt, memoryContent);
    this.cachedContentName = cachedContentName;
    this.lastUpdateTime = Date.now();
    debugLogger.debug('Prompt cache updated:', cachedContentName);
  }

  /**
   * Gets the current cached content name, if valid.
   */
  getCachedContentName(): string | null {
    return this.cachedContentName;
  }

  /**
   * Invalidates the cache.
   */
  invalidate(): void {
    this.contentHash = null;
    this.cachedContentName = null;
    debugLogger.debug('Prompt cache invalidated');
  }

  /**
   * Gets cache age in milliseconds.
   */
  getCacheAge(): number {
    if (this.lastUpdateTime === 0) return Infinity;
    return Date.now() - this.lastUpdateTime;
  }
}
