/**
 * Dead Letter Queue (DLQ) Service
 *
 * Captures failed records during sync for later analysis and retry.
 * Uses file-based storage to persist across restarts.
 *
 * Key features:
 * - Per-record failure tracking (not just batch-level)
 * - Deduplication (updates retry_count on re-failure)
 * - Size-bounded (MAX_DLQ_SIZE prevents unbounded growth)
 * - Breakdown by model AND failure stage
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * A record that failed during sync
 */
export interface DLQRecord {
  // Identity
  record_id: number;
  model_name: string;
  model_id: number;

  // Error details
  failure_stage: 'encoding' | 'embedding' | 'upsert';
  error_message: string;

  // Context
  batch_number: number;
  encoded_string?: string;  // The coordinate string (if encoding succeeded)

  // Timing
  failed_at: string;        // ISO timestamp
  retry_count: number;
}

const DLQ_DIR = join(process.cwd(), 'data');
const DLQ_FILE = join(DLQ_DIR, 'dlq.json');
const MAX_DLQ_SIZE = 1000;  // Prevent unbounded growth

/**
 * Add a failed record to the DLQ
 * Writes immediately to file (no memory accumulation)
 */
export function addToDLQ(record: DLQRecord): void {
  // Ensure directory exists
  if (!existsSync(DLQ_DIR)) {
    mkdirSync(DLQ_DIR, { recursive: true });
  }

  let dlq: DLQRecord[] = [];
  if (existsSync(DLQ_FILE)) {
    try {
      dlq = JSON.parse(readFileSync(DLQ_FILE, 'utf-8'));
    } catch {
      dlq = [];  // Start fresh if corrupted
    }
  }

  // Check if already in DLQ (avoid duplicates on retry)
  const existingIndex = dlq.findIndex(
    r => r.record_id === record.record_id && r.model_name === record.model_name
  );

  if (existingIndex >= 0) {
    // Update existing entry (increment retry count)
    dlq[existingIndex] = {
      ...record,
      retry_count: dlq[existingIndex].retry_count + 1,
    };
    console.error(`[DLQ] Updated ${record.model_name}:${record.record_id} (retry #${dlq[existingIndex].retry_count})`);
  } else {
    // Add new entry
    dlq.push(record);
    console.error(`[DLQ] Added ${record.model_name}:${record.record_id} (${record.failure_stage})`);
  }

  // Enforce size limit (remove oldest entries)
  if (dlq.length > MAX_DLQ_SIZE) {
    const removed = dlq.length - MAX_DLQ_SIZE;
    dlq = dlq.slice(-MAX_DLQ_SIZE);
    console.error(`[DLQ] Size limit reached, ${removed} oldest entries removed`);
  }

  writeFileSync(DLQ_FILE, JSON.stringify(dlq, null, 2));
}

/**
 * Get all DLQ records, optionally filtered by model
 */
export function getDLQRecords(modelName?: string): DLQRecord[] {
  if (!existsSync(DLQ_FILE)) return [];
  try {
    const dlq: DLQRecord[] = JSON.parse(readFileSync(DLQ_FILE, 'utf-8'));
    return modelName ? dlq.filter(r => r.model_name === modelName) : dlq;
  } catch {
    return [];
  }
}

/**
 * Get DLQ statistics
 */
export function getDLQStats(): {
  total: number;
  by_model: Record<string, number>;
  by_stage: Record<string, number>;
} {
  const records = getDLQRecords();
  const by_model: Record<string, number> = {};
  const by_stage: Record<string, number> = {};

  for (const r of records) {
    by_model[r.model_name] = (by_model[r.model_name] || 0) + 1;
    by_stage[r.failure_stage] = (by_stage[r.failure_stage] || 0) + 1;
  }

  return { total: records.length, by_model, by_stage };
}

/**
 * Clear DLQ records, optionally filtered by model
 * Returns number of records cleared
 */
export function clearDLQ(modelName?: string): number {
  if (!existsSync(DLQ_FILE)) return 0;

  let dlq: DLQRecord[] = [];
  try {
    dlq = JSON.parse(readFileSync(DLQ_FILE, 'utf-8'));
  } catch {
    return 0;
  }

  const originalCount = dlq.length;

  if (modelName) {
    dlq = dlq.filter(r => r.model_name !== modelName);
  } else {
    dlq = [];
  }

  writeFileSync(DLQ_FILE, JSON.stringify(dlq, null, 2));
  console.error(`[DLQ] Cleared ${originalCount - dlq.length} records${modelName ? ` for ${modelName}` : ''}`);
  return originalCount - dlq.length;
}

/**
 * Remove a specific record from DLQ (after successful retry)
 */
export function removeFromDLQ(modelName: string, recordId: number): boolean {
  if (!existsSync(DLQ_FILE)) return false;

  let dlq: DLQRecord[] = [];
  try {
    dlq = JSON.parse(readFileSync(DLQ_FILE, 'utf-8'));
  } catch {
    return false;
  }

  const newDlq = dlq.filter(
    r => !(r.record_id === recordId && r.model_name === modelName)
  );

  if (newDlq.length < dlq.length) {
    writeFileSync(DLQ_FILE, JSON.stringify(newDlq, null, 2));
    console.error(`[DLQ] Removed ${modelName}:${recordId}`);
    return true;
  }
  return false;
}
