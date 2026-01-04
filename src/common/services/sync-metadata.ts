/**
 * Sync Metadata Service
 *
 * Tracks field checksums for incremental sync.
 * Detects added, modified, and deleted fields between syncs.
 *
 * Key Design Decisions:
 * 1. Checksum based on semantic_text (what gets embedded)
 * 2. File-based storage (persists across restarts)
 * 3. All-or-nothing save (only after successful sync)
 *
 * Integration with Caching (Improvement #2):
 * - If changes detected → incremental sync clears cache
 * - If no changes → cache preserved (instant return)
 */

import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import * as path from 'path';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Sync metadata stored between syncs
 */
export interface SyncMetadata {
  /** ISO timestamp of last sync */
  lastSync: string;
  /** Total field count at last sync */
  totalFields: number;
  /** MD5 of schema file for quick change detection */
  schemaFileHash: string;
  /** field_id → semantic_text hash mapping */
  fieldChecksums: Record<string, string>;
  /** Version for future migration */
  version: number;
}

/**
 * Detected changes between syncs
 */
export interface ChangeSet {
  /** Field IDs that are new (not in previous sync) */
  added: number[];
  /** Field IDs that changed (different checksum) */
  modified: number[];
  /** Field IDs that were removed (in previous, not in current) */
  deleted: number[];
}

// =============================================================================
// CONFIGURATION
// =============================================================================

const METADATA_VERSION = 1;
const METADATA_DIR = path.resolve(process.cwd(), 'data');
const METADATA_FILE = path.join(METADATA_DIR, 'sync-metadata.json');

// =============================================================================
// CHECKSUM FUNCTIONS
// =============================================================================

/**
 * Generate MD5 checksum for a string
 */
export function generateChecksum(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

/**
 * Generate checksum for a schema field's semantic text
 *
 * We hash semantic_text because that's what gets embedded.
 * If semantic_text changes, the embedding needs to be regenerated.
 */
export function generateFieldChecksum(semanticText: string): string {
  return generateChecksum(semanticText);
}

/**
 * Generate checksum for entire schema file (quick change detection)
 */
export function generateSchemaFileHash(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return generateChecksum(content);
  } catch {
    return '';
  }
}

// =============================================================================
// METADATA PERSISTENCE
// =============================================================================

/**
 * Load previous sync metadata from file
 *
 * Returns null if:
 * - File doesn't exist (first sync)
 * - File is corrupted
 * - Version mismatch (future migration)
 */
export function loadSyncMetadata(): SyncMetadata | null {
  if (!existsSync(METADATA_FILE)) {
    console.error('[SyncMetadata] No metadata file found - first sync');
    return null;
  }

  try {
    const content = readFileSync(METADATA_FILE, 'utf-8');
    const metadata = JSON.parse(content) as SyncMetadata;

    // Version check for future migrations
    if (metadata.version !== METADATA_VERSION) {
      console.error(`[SyncMetadata] Version mismatch (${metadata.version} vs ${METADATA_VERSION}) - full sync required`);
      return null;
    }

    console.error(`[SyncMetadata] Loaded metadata from ${metadata.lastSync} (${metadata.totalFields} fields)`);
    return metadata;
  } catch (error) {
    console.error('[SyncMetadata] Failed to load metadata:', error);
    return null;
  }
}

/**
 * Save sync metadata to file
 *
 * Only call this AFTER successful sync completion.
 */
export function saveSyncMetadata(metadata: SyncMetadata): void {
  try {
    // Ensure data directory exists
    if (!existsSync(METADATA_DIR)) {
      mkdirSync(METADATA_DIR, { recursive: true });
    }

    writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
    console.error(`[SyncMetadata] Saved metadata (${metadata.totalFields} fields)`);
  } catch (error) {
    console.error('[SyncMetadata] Failed to save metadata:', error);
    throw error; // Re-throw so caller knows save failed
  }
}

/**
 * Delete metadata file (for testing or reset)
 */
export function clearSyncMetadata(): void {
  try {
    if (existsSync(METADATA_FILE)) {
      const fs = require('fs');
      fs.unlinkSync(METADATA_FILE);
      console.error('[SyncMetadata] Metadata file deleted');
    }
  } catch (error) {
    console.error('[SyncMetadata] Failed to clear metadata:', error);
  }
}

// =============================================================================
// CHANGE DETECTION
// =============================================================================

/**
 * Detect changes between previous sync and current schema
 *
 * @param previous - Metadata from previous sync (null = first sync)
 * @param currentChecksums - Map of field_id → semantic_text checksum
 * @returns ChangeSet with added, modified, and deleted field IDs
 */
export function detectChanges(
  previous: SyncMetadata | null,
  currentChecksums: Map<number, string>
): ChangeSet {
  // First sync - all fields are "added"
  if (!previous) {
    return {
      added: Array.from(currentChecksums.keys()),
      modified: [],
      deleted: [],
    };
  }

  const added: number[] = [];
  const modified: number[] = [];
  const deleted: number[] = [];

  // Check current fields against previous
  for (const [fieldId, checksum] of currentChecksums) {
    const fieldIdStr = String(fieldId);
    const previousChecksum = previous.fieldChecksums[fieldIdStr];

    if (previousChecksum === undefined) {
      // New field - not in previous sync
      added.push(fieldId);
    } else if (previousChecksum !== checksum) {
      // Modified - checksum changed
      modified.push(fieldId);
    }
    // else: unchanged
  }

  // Check for deleted fields (in previous but not in current)
  for (const fieldIdStr of Object.keys(previous.fieldChecksums)) {
    const fieldId = parseInt(fieldIdStr, 10);
    if (!currentChecksums.has(fieldId)) {
      deleted.push(fieldId);
    }
  }

  return { added, modified, deleted };
}

/**
 * Quick check if schema file changed since last sync
 *
 * This is a fast first-pass check. If file hash matches,
 * we can skip detailed change detection entirely.
 */
export function hasSchemaFileChanged(
  schemaFilePath: string,
  previousMetadata: SyncMetadata | null
): boolean {
  if (!previousMetadata) {
    return true; // No previous metadata = definitely changed
  }

  const currentHash = generateSchemaFileHash(schemaFilePath);
  return currentHash !== previousMetadata.schemaFileHash;
}

/**
 * Build checksums map from schema rows and their semantic texts
 *
 * @param schemas - Array of {field_id, semanticText} pairs
 * @returns Map of field_id → checksum
 */
export function buildChecksumMap(
  schemas: Array<{ field_id: number; semanticText: string }>
): Map<number, string> {
  const checksums = new Map<number, string>();

  for (const { field_id, semanticText } of schemas) {
    checksums.set(field_id, generateFieldChecksum(semanticText));
  }

  return checksums;
}

/**
 * Create metadata object for saving after sync
 */
export function createSyncMetadata(
  schemaFilePath: string,
  checksums: Map<number, string>
): SyncMetadata {
  const fieldChecksums: Record<string, string> = {};

  for (const [fieldId, checksum] of checksums) {
    fieldChecksums[String(fieldId)] = checksum;
  }

  return {
    lastSync: new Date().toISOString(),
    totalFields: checksums.size,
    schemaFileHash: generateSchemaFileHash(schemaFilePath),
    fieldChecksums,
    version: METADATA_VERSION,
  };
}

// =============================================================================
// STATISTICS
// =============================================================================

/**
 * Get summary of changes for logging
 */
export function formatChangesSummary(changes: ChangeSet): string {
  const { added, modified, deleted } = changes;
  const total = added.length + modified.length + deleted.length;

  if (total === 0) {
    return 'No changes detected';
  }

  const parts: string[] = [];
  if (added.length > 0) parts.push(`${added.length} added`);
  if (modified.length > 0) parts.push(`${modified.length} modified`);
  if (deleted.length > 0) parts.push(`${deleted.length} deleted`);

  return parts.join(', ');
}

// =============================================================================
// DATA SYNC METADATA (for incremental sync of Odoo records)
// =============================================================================

/**
 * Data sync metadata stored between syncs
 */
interface DataSyncModelMetadata {
  /** ISO timestamp when sync completed */
  last_sync_timestamp: string;
  /** Highest write_date seen in synced records */
  last_max_write_date: string;
  /** Number of records synced */
  records_synced: number;
  /** Sync duration in milliseconds */
  sync_duration_ms: number;
}

interface DataSyncMetadataStore {
  models: Record<string, DataSyncModelMetadata>;
  version: number;
}

const DATA_SYNC_METADATA_FILE = path.join(METADATA_DIR, 'data_sync_metadata.json');

/**
 * Get the last write_date for incremental sync of a model
 *
 * @param modelName - Odoo model name (e.g., 'res.partner')
 * @returns ISO date string of last_max_write_date, or null if never synced
 */
export function getLastDataSyncTimestamp(modelName: string): string | null {
  if (!existsSync(DATA_SYNC_METADATA_FILE)) return null;

  try {
    const data: DataSyncMetadataStore = JSON.parse(readFileSync(DATA_SYNC_METADATA_FILE, 'utf-8'));
    return data.models[modelName]?.last_max_write_date || null;
  } catch {
    return null;
  }
}

/**
 * Save data sync metadata for a model
 *
 * @param modelName - Odoo model name
 * @param maxWriteDate - Highest write_date from synced records
 * @param recordCount - Number of records synced
 * @param durationMs - Sync duration in milliseconds
 */
export function saveDataSyncMetadata(
  modelName: string,
  maxWriteDate: string,
  recordCount: number,
  durationMs: number
): void {
  let data: DataSyncMetadataStore = { models: {}, version: 1 };

  // Ensure data directory exists
  if (!existsSync(METADATA_DIR)) {
    mkdirSync(METADATA_DIR, { recursive: true });
  }

  // Load existing data if present
  if (existsSync(DATA_SYNC_METADATA_FILE)) {
    try {
      data = JSON.parse(readFileSync(DATA_SYNC_METADATA_FILE, 'utf-8'));
    } catch {
      console.error('[DataSyncMetadata] Existing file corrupt, starting fresh');
    }
  }

  data.models[modelName] = {
    last_sync_timestamp: new Date().toISOString(),
    last_max_write_date: maxWriteDate,
    records_synced: recordCount,
    sync_duration_ms: durationMs,
  };

  writeFileSync(DATA_SYNC_METADATA_FILE, JSON.stringify(data, null, 2));
  console.error(`[DataSyncMetadata] Saved: ${modelName} last_write_date=${maxWriteDate}`);
}

/**
 * Clear data sync metadata for a model (forces full sync next time)
 *
 * @param modelName - Odoo model name
 */
export function clearDataSyncMetadata(modelName: string): void {
  if (!existsSync(DATA_SYNC_METADATA_FILE)) return;

  try {
    const data: DataSyncMetadataStore = JSON.parse(readFileSync(DATA_SYNC_METADATA_FILE, 'utf-8'));
    delete data.models[modelName];
    writeFileSync(DATA_SYNC_METADATA_FILE, JSON.stringify(data, null, 2));
    console.error(`[DataSyncMetadata] Cleared metadata for ${modelName}`);
  } catch (error) {
    console.error(`[DataSyncMetadata] Failed to clear: ${error}`);
  }
}

/**
 * Get full data sync metadata for a model
 *
 * @param modelName - Odoo model name
 * @returns DataSyncModelMetadata or null if never synced
 */
export function getDataSyncMetadata(modelName: string): DataSyncModelMetadata | null {
  if (!existsSync(DATA_SYNC_METADATA_FILE)) return null;

  try {
    const data: DataSyncMetadataStore = JSON.parse(readFileSync(DATA_SYNC_METADATA_FILE, 'utf-8'));
    return data.models[modelName] || null;
  } catch {
    return null;
  }
}

/**
 * Get all data sync metadata
 *
 * @returns Full metadata store or empty object
 */
export function getAllDataSyncMetadata(): Record<string, DataSyncModelMetadata> {
  if (!existsSync(DATA_SYNC_METADATA_FILE)) return {};

  try {
    const data: DataSyncMetadataStore = JSON.parse(readFileSync(DATA_SYNC_METADATA_FILE, 'utf-8'));
    return data.models;
  } catch {
    return {};
  }
}

/**
 * Find maximum write_date from an array of records
 *
 * @param records - Array of Odoo records with write_date field
 * @returns ISO date string of maximum write_date, or null if none found
 */
export function findMaxWriteDate(records: Record<string, unknown>[]): string | null {
  let maxDate: Date | null = null;

  for (const record of records) {
    const writeDate = record.write_date;
    if (typeof writeDate === 'string') {
      const date = new Date(writeDate);
      if (!isNaN(date.getTime()) && (!maxDate || date > maxDate)) {
        maxDate = date;
      }
    }
  }

  return maxDate?.toISOString() || null;
}
