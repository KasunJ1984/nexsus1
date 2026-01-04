/**
 * Embedding Service
 *
 * Generates vector embeddings using Voyage AI.
 * Uses voyage-3 model (1024 dimensions).
 */

import { VoyageAIClient } from 'voyageai';
import { VOYAGE_CONFIG } from '../constants.js';

// =============================================================================
// CLIENT INITIALIZATION
// =============================================================================

let voyageClient: VoyageAIClient | null = null;

/**
 * Initialize the Voyage AI client
 */
export function initializeEmbeddingService(): boolean {
  if (!VOYAGE_CONFIG.API_KEY) {
    console.error('[Embedding] VOYAGE_API_KEY not set - embedding service disabled');
    return false;
  }

  try {
    voyageClient = new VoyageAIClient({ apiKey: VOYAGE_CONFIG.API_KEY });
    console.error(`[Embedding] Voyage AI service initialized (model: ${VOYAGE_CONFIG.MODEL}, dimensions: ${VOYAGE_CONFIG.DIMENSIONS})`);
    return true;
  } catch (error) {
    console.error('[Embedding] Failed to initialize:', error);
    return false;
  }
}

/**
 * Check if embedding service is available
 */
export function isEmbeddingServiceAvailable(): boolean {
  return voyageClient !== null;
}

// =============================================================================
// EMBEDDING FUNCTIONS
// =============================================================================

/**
 * Generate embedding for a single text
 *
 * @param text - Text to embed
 * @param inputType - 'document' for indexing, 'query' for search queries
 */
export async function embed(
  text: string,
  inputType: 'document' | 'query' = 'document'
): Promise<number[]> {
  if (!voyageClient) {
    throw new Error('Embedding service not initialized');
  }

  // Truncate if too long (rough estimate: 4 chars per token, max ~8000 tokens)
  const maxChars = 30000;
  const truncatedText = text.length > maxChars ? text.slice(0, maxChars) : text;

  const response = await voyageClient.embed({
    input: truncatedText,
    model: VOYAGE_CONFIG.MODEL,
    inputType: inputType,
  });

  if (!response.data || !response.data[0] || !response.data[0].embedding) {
    throw new Error('Invalid embedding response');
  }

  return response.data[0].embedding;
}

/**
 * Maximum tokens per batch for Voyage AI.
 * Voyage AI limit is 320,000 tokens per batch.
 * We use 280,000 to leave a safety margin for token counting variance.
 */
const MAX_BATCH_TOKENS = 280000;

/**
 * Maximum items per batch for Voyage AI.
 * Voyage AI hard limit is 1000 items per batch.
 * We use 1000 exactly since this is a hard limit.
 */
const MAX_BATCH_ITEMS = 1000;

/**
 * Maximum characters per individual text.
 * Voyage AI has a per-text limit. We truncate at 30,000 chars
 * which is approximately 7,500 tokens (well under any limits).
 */
const MAX_CHARS_PER_TEXT = 30000;

// =============================================================================
// TEXT SANITIZATION
// =============================================================================

/**
 * Sanitize texts before sending to Voyage AI.
 *
 * Fixes issues that cause "Bad Request" errors:
 * - Null bytes (\x00) in text
 * - Empty or whitespace-only strings
 * - Excessively long individual texts
 * - Invalid UTF-8 sequences
 *
 * @param texts - Array of texts to sanitize
 * @returns Sanitized texts safe for embedding API
 */
function sanitizeTexts(texts: string[]): string[] {
  return texts.map((text, idx) => {
    // Handle null/undefined
    if (text === null || text === undefined) {
      console.error(`[Embedding] Text at index ${idx} is null/undefined, replacing with placeholder`);
      return '[no content]';
    }

    // Convert to string if not already
    let clean = String(text);

    // Remove null bytes (causes "Bad Request")
    if (clean.includes('\x00')) {
      clean = clean.replace(/\x00/g, '');
      console.error(`[Embedding] Removed null bytes from text at index ${idx}`);
    }

    // Remove other control characters (except newlines, tabs)
    // Control characters: 0x00-0x08, 0x0B-0x0C, 0x0E-0x1F
    clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

    // Handle empty or whitespace-only strings
    if (!clean || clean.trim().length === 0) {
      return '[empty]';
    }

    // Truncate if too long (per-text limit)
    if (clean.length > MAX_CHARS_PER_TEXT) {
      clean = clean.slice(0, MAX_CHARS_PER_TEXT);
      console.error(`[Embedding] Truncated text at index ${idx} from ${text.length} to ${MAX_CHARS_PER_TEXT} chars`);
    }

    return clean;
  });
}

/**
 * Create token-aware and item-aware batches that stay under Voyage AI's limits.
 *
 * Instead of batching by count only (which can exceed token limits with long texts),
 * this function groups texts so each batch stays under BOTH:
 * - MAX_BATCH_TOKENS (280,000 tokens)
 * - MAX_BATCH_ITEMS (1,000 items)
 *
 * @param texts - Array of texts to batch
 * @returns Array of batches, where each batch is an array of texts
 */
function createTokenAwareBatches(texts: string[]): string[][] {
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentTokens = 0;

  for (const text of texts) {
    const textTokens = estimateTokens(text);

    // If this single text exceeds the token limit, put it in its own batch
    // (Voyage will truncate it, but we can't split it further)
    if (textTokens >= MAX_BATCH_TOKENS) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }
      batches.push([text]);
      continue;
    }

    // Start a new batch if:
    // 1. Adding this text would exceed the token limit, OR
    // 2. Adding this text would exceed the item limit (1000)
    if (
      currentTokens + textTokens > MAX_BATCH_TOKENS ||
      currentBatch.length >= MAX_BATCH_ITEMS
    ) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }
      currentBatch = [text];
      currentTokens = textTokens;
    } else {
      currentBatch.push(text);
      currentTokens += textTokens;
    }
  }

  // Don't forget the last batch
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Generate embeddings for multiple texts (batch)
 *
 * Uses token-aware batching to stay under Voyage AI's 320,000 token limit.
 * Each batch is sized by estimated token count, not by text count.
 *
 * @param texts - Array of texts to embed
 * @param inputType - 'document' for indexing, 'query' for search queries
 * @param onProgress - Optional progress callback
 */
export async function embedBatch(
  texts: string[],
  inputType: 'document' | 'query' = 'document',
  onProgress?: (current: number, total: number) => void
): Promise<number[][]> {
  if (!voyageClient) {
    throw new Error('Embedding service not initialized');
  }

  const results: number[][] = [];

  // Sanitize texts (removes null bytes, handles empty strings, truncates long texts)
  // This prevents "Bad Request" errors from Voyage AI
  const sanitizedTexts = sanitizeTexts(texts);

  // Create token-aware batches (stays under 280,000 tokens per batch)
  const batches = createTokenAwareBatches(sanitizedTexts);
  let processedCount = 0;

  console.error(`[Embedding] Processing ${sanitizedTexts.length} texts in ${batches.length} token-aware batches`);

  // Process each batch with retry on failure
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const batchTokens = batch.reduce((sum, t) => sum + estimateTokens(t), 0);

    console.error(`[Embedding] Batch ${batchIdx + 1}/${batches.length}: ${batch.length} texts, ~${batchTokens.toLocaleString()} tokens`);

    try {
      const response = await voyageClient.embed({
        input: batch,
        model: VOYAGE_CONFIG.MODEL,
        inputType: inputType,
      });

      if (!response.data) {
        throw new Error('Invalid batch embedding response');
      }

      for (const item of response.data) {
        if (item.embedding) {
          results.push(item.embedding);
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // If batch fails with "Bad Request", try embedding one at a time
      if (errorMsg.includes('Bad Request') || errorMsg.includes('400')) {
        console.error(`[Embedding] Batch ${batchIdx + 1} failed with Bad Request - trying individual embedding`);

        for (let i = 0; i < batch.length; i++) {
          try {
            const singleResponse = await voyageClient.embed({
              input: batch[i],
              model: VOYAGE_CONFIG.MODEL,
              inputType: inputType,
            });

            if (singleResponse.data && singleResponse.data[0]?.embedding) {
              results.push(singleResponse.data[0].embedding);
            } else {
              // Use zero vector for failed texts
              console.error(`[Embedding] Failed to embed text ${i} in batch ${batchIdx + 1}, using zero vector`);
              results.push(new Array(1024).fill(0));
            }
          } catch (singleError) {
            // Use zero vector for failed texts
            console.error(`[Embedding] Failed to embed text ${i} in batch ${batchIdx + 1}: ${singleError instanceof Error ? singleError.message : String(singleError)}`);
            results.push(new Array(1024).fill(0));
          }
        }
      } else {
        // Re-throw other errors
        throw error;
      }
    }

    processedCount += batch.length;

    if (onProgress) {
      onProgress(processedCount, sanitizedTexts.length);
    }
  }

  return results;
}

/**
 * Estimate token count for cost calculation (rough)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
