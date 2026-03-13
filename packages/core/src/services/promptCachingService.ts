/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import type {
  Caches,
  CachedContent,
  Content,
} from '@google/genai';
import { debugLogger } from '../utils/debugLogger.js';

/** Default TTL for cached content: 30 minutes. */
const DEFAULT_TTL = '1800s';

/**
 * Prompt Caching Service.
 *
 * Creates and manages Gemini cached content objects so that the system
 * prompt and initial context are only uploaded once and reused across
 * subsequent API calls.  When the underlying content changes (detected
 * via SHA-256 hash), the old cache entry is deleted and a new one is
 * created automatically.
 *
 * Callers should:
 * 1. Call {@link getOrCreateCache} before each generateContent request.
 * 2. Pass the returned cache name via `GenerateContentConfig.cachedContent`.
 *
 * Example integration in the request path:
 * ```typescript
 * const cacheName = await cachingService.getOrCreateCache(
 *   model,
 *   systemPrompt,
 *   memoryContent,
 *   initialContents,
 * );
 * const config: GenerateContentConfig = {
 *   ...existingConfig,
 *   cachedContent: cacheName ?? undefined,
 * };
 * ```
 */
export class PromptCachingService {
  private contentHash: string | null = null;
  private cachedContentName: string | null = null;
  private lastUpdateTime: number = 0;
  private caches: Caches | null = null;
  /** Guards against concurrent cache creation. */
  private pendingCacheCreation: Promise<string | null> | null = null;

  /**
   * Attaches the SDK Caches module.  Must be called before
   * {@link getOrCreateCache} can create server-side caches.
   *
   * If never called the service falls back to hash-tracking only
   * (no server-side caching).
   */
  setCaches(caches: Caches): void {
    this.caches = caches;
  }

  /**
   * Computes a SHA-256 hash of the supplied content strings.
   */
  computeHash(...contents: string[]): string {
    const hash = crypto.createHash('sha256');
    for (const content of contents) {
      hash.update(content);
    }
    return hash.digest('hex');
  }

  /**
   * Checks if the content has changed since the last cache creation.
   */
  hasContentChanged(systemPrompt: string, memoryContent: string): boolean {
    const newHash = this.computeHash(systemPrompt, memoryContent);
    return this.contentHash === null || this.contentHash !== newHash;
  }

  /**
   * Returns an existing cached content name or creates a new one.
   *
   * If the content hash has not changed and a valid cache name exists,
   * the existing name is returned without any network call.
   *
   * When the content has changed the old cache entry is deleted (best
   * effort) and a new one is created.
   *
   * Returns `null` when the Caches module has not been set (fallback
   * mode) or when cache creation fails (the caller should proceed
   * without caching).
   *
   * @param model      The model ID (e.g. "gemini-2.0-flash").
   * @param systemPrompt  The system instruction text.
   * @param memoryContent GEMINI.md / memory content.
   * @param contents    Optional initial conversation context to cache.
   * @param ttl         TTL duration string (default "1800s").
   */
  async getOrCreateCache(
    model: string,
    systemPrompt: string,
    memoryContent: string,
    contents?: Content[],
    ttl: string = DEFAULT_TTL,
  ): Promise<string | null> {
    // Fast path: content unchanged and we already have a cache.
    if (!this.hasContentChanged(systemPrompt, memoryContent)
        && this.cachedContentName !== null) {
      return this.cachedContentName;
    }

    // No SDK Caches module — fall back to hash tracking only.
    if (this.caches === null) {
      debugLogger.debug(
        'Caches module not set; skipping server-side cache creation',
      );
      return null;
    }

    // Deduplicate concurrent calls for the same content.
    if (this.pendingCacheCreation !== null) {
      return this.pendingCacheCreation;
    }

    this.pendingCacheCreation = this.createCacheInternal(
      model,
      systemPrompt,
      memoryContent,
      contents,
      ttl,
    );
    try {
      return await this.pendingCacheCreation;
    } finally {
      this.pendingCacheCreation = null;
    }
  }

  /**
   * Gets the current cached content name, if valid.
   */
  getCachedContentName(): string | null {
    return this.cachedContentName;
  }

  /**
   * Invalidates the local cache state and deletes the server-side
   * cached content (best effort).
   */
  async invalidate(): Promise<void> {
    const nameToDelete = this.cachedContentName;
    this.contentHash = null;
    this.cachedContentName = null;
    debugLogger.debug('Prompt cache invalidated');

    if (nameToDelete !== null && this.caches !== null) {
      try {
        await this.caches.delete({ name: nameToDelete });
        debugLogger.debug('Deleted server-side cache:', nameToDelete);
      } catch (err) {
        debugLogger.debug(
          'Failed to delete server-side cache (non-fatal):',
          err,
        );
      }
    }
  }

  /**
   * Gets cache age in milliseconds.
   */
  getCacheAge(): number {
    if (this.lastUpdateTime === 0) return Infinity;
    return Date.now() - this.lastUpdateTime;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Deletes any existing cache, creates a new one, and updates
   * local state.
   */
  private async createCacheInternal(
    model: string,
    systemPrompt: string,
    memoryContent: string,
    contents: Content[] | undefined,
    ttl: string,
  ): Promise<string | null> {
    // Delete the previous cache entry (best effort).
    if (this.cachedContentName !== null && this.caches !== null) {
      try {
        await this.caches.delete({ name: this.cachedContentName });
        debugLogger.debug(
          'Deleted previous cache entry:',
          this.cachedContentName,
        );
      } catch (err) {
        debugLogger.debug(
          'Failed to delete previous cache (non-fatal):',
          err,
        );
      }
    }

    try {
      const cached: CachedContent = await this.caches!.create({
        model,
        config: {
          displayName: 'gemini-cli-prompt-cache',
          systemInstruction: systemPrompt,
          contents: contents ?? [],
          ttl,
        },
      });

      const name = cached.name ?? null;
      if (name !== null) {
        this.updateCacheState(systemPrompt, memoryContent, name);
        debugLogger.debug('Created server-side cache:', name);
      }
      return name;
    } catch (err) {
      debugLogger.debug(
        'Failed to create cached content (falling back to no cache):',
        err,
      );
      // Clear stale state so the next call retries.
      this.contentHash = null;
      this.cachedContentName = null;
      return null;
    }
  }

  /**
   * Updates the local cache tracking state after a successful
   * server-side cache creation.
   */
  private updateCacheState(
    systemPrompt: string,
    memoryContent: string,
    cachedContentName: string,
  ): void {
    this.contentHash = this.computeHash(systemPrompt, memoryContent);
    this.cachedContentName = cachedContentName;
    this.lastUpdateTime = Date.now();
  }
}
