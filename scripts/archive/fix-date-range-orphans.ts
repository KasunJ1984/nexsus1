/**
 * Fix FK orphans for a specific date range of account.move.line records
 * Optimized version with batch UUID checking
 *
 * Usage: npx tsx scripts/fix-date-range-orphans.ts
 */

// IMPORTANT: This import MUST be first - it loads .env before other imports
import 'dotenv/config';

import { getQdrantClient, initializeVectorClient } from '../dist/services/vector-client.js';
import { initializeEmbeddingService } from '../dist/services/embedding-service.js';
import { syncPipelineData } from '../dist/services/pipeline-data-sync.js';
import { UNIFIED_CONFIG } from '../dist/constants.js';

// Date range: 31-Dec-2024 to 01-Feb-2025
// Corresponds to record IDs: 663604 to 692232
const MIN_RECORD_ID = 663604;
const MAX_RECORD_ID = 692232;
const BATCH_SIZE = 1000;
const UUID_CHECK_BATCH = 100;

// Model ID to name mapping for FK targets
const modelIdToName: Record<number, string> = {
  398: 'sale.order.line',
  371: 'purchase.order.line',
  313: 'account.partial.reconcile',
  311: 'account.move',
  296: 'account.journal',
  78: 'res.partner',
  90: 'res.users',
  193: 'product.product',
  178: 'account.analytic.line',
};

async function main() {
  console.log('='.repeat(70));
  console.log('Fix FK Orphans for Date Range: 31-Dec-2024 to 01-Feb-2025');
  console.log('Record ID Range:', MIN_RECORD_ID, 'to', MAX_RECORD_ID);
  console.log('='.repeat(70));
  console.log();

  // Initialize services
  console.log('Initializing services...');
  await initializeVectorClient();
  initializeEmbeddingService();
  const client = getQdrantClient();

  // Collect all FK UUIDs from records in the date range
  console.log('\nPhase 1: Collecting FK references from date range...');

  const allFkUuids = new Map<string, Set<string>>(); // fieldName -> Set of UUIDs
  let totalRecords = 0;
  let offset: string | number | null = null;

  do {
    const scrollParams: any = {
      filter: {
        must: [
          { key: 'point_type', match: { value: 'data' } },
          { key: 'model_name', match: { value: 'account.move.line' } },
          { key: 'record_id', range: { gte: MIN_RECORD_ID, lte: MAX_RECORD_ID } }
        ]
      },
      limit: BATCH_SIZE,
      with_payload: true,
      with_vector: false
    };

    if (offset !== null) {
      scrollParams.offset = offset;
    }

    const batch = await client.scroll(UNIFIED_CONFIG.COLLECTION_NAME, scrollParams);

    for (const point of batch.points) {
      totalRecords++;
      const payload = point.payload as Record<string, unknown>;

      // Collect all *_qdrant fields
      for (const [key, value] of Object.entries(payload)) {
        if (!key.endsWith('_qdrant') || !value) continue;

        const fieldName = key.replace('_qdrant', '');
        if (!allFkUuids.has(fieldName)) {
          allFkUuids.set(fieldName, new Set());
        }

        const uuids = Array.isArray(value) ? value : [value];
        for (const uuid of uuids) {
          if (typeof uuid === 'string' && uuid.startsWith('00000002-')) {
            allFkUuids.get(fieldName)!.add(uuid);
          }
        }
      }
    }

    offset = batch.next_page_offset ?? null;

    if (totalRecords % 5000 === 0) {
      console.log(`  Scanned ${totalRecords.toLocaleString()} records...`);
    }
  } while (offset !== null);

  console.log(`  Collected ${totalRecords.toLocaleString()} records`);

  // Count unique UUIDs per field
  let totalUuids = 0;
  for (const [field, uuids] of allFkUuids) {
    totalUuids += uuids.size;
    console.log(`  ${field}: ${uuids.size.toLocaleString()} unique references`);
  }

  // Phase 2: Batch check which UUIDs exist
  console.log(`\nPhase 2: Checking ${totalUuids.toLocaleString()} UUIDs for existence...`);

  const orphansByModel = new Map<string, Set<number>>(); // modelName -> Set of record IDs
  let checkedCount = 0;

  for (const [fieldName, uuidSet] of allFkUuids) {
    const uuids = Array.from(uuidSet);

    // Process in batches
    for (let i = 0; i < uuids.length; i += UUID_CHECK_BATCH) {
      const batch = uuids.slice(i, i + UUID_CHECK_BATCH);

      try {
        const result = await client.retrieve(UNIFIED_CONFIG.COLLECTION_NAME, {
          ids: batch,
          with_payload: false,
          with_vector: false
        });

        const existingIds = new Set(result.map((p: any) => p.id));

        // Find missing UUIDs
        for (const uuid of batch) {
          checkedCount++;
          if (!existingIds.has(uuid)) {
            const parsed = parseDataUuid(uuid);
            if (parsed) {
              const modelName = modelIdToName[parsed.modelId] || `model_id:${parsed.modelId}`;
              if (!orphansByModel.has(modelName)) {
                orphansByModel.set(modelName, new Set());
              }
              orphansByModel.get(modelName)!.add(parsed.recordId);
            }
          }
        }
      } catch (err) {
        console.error(`  Error checking batch: ${err}`);
      }
    }

    if (checkedCount % 10000 === 0) {
      console.log(`  Checked ${checkedCount.toLocaleString()} / ${totalUuids.toLocaleString()} UUIDs...`);
    }
  }

  // Summary
  console.log('\n' + '-'.repeat(70));
  console.log('Orphan Summary (Date Range Only)');
  console.log('-'.repeat(70));

  let totalOrphans = 0;
  for (const [modelName, ids] of orphansByModel) {
    console.log(`  ${modelName}: ${ids.size} missing records`);
    totalOrphans += ids.size;
  }
  console.log(`  Total: ${totalOrphans} orphan references`);

  if (totalOrphans === 0) {
    console.log('\n✓ No orphans found! FK integrity is 100% for this date range.');
    return;
  }

  // Phase 3: Sync missing records
  console.log('\n' + '-'.repeat(70));
  console.log('Phase 3: Syncing missing records...');
  console.log('-'.repeat(70));

  let totalSynced = 0;
  for (const [modelName, ids] of orphansByModel) {
    if (modelName.startsWith('model_id:')) {
      console.log(`\n  Skipping ${modelName} (not in schema)`);
      continue;
    }

    const idsArray = Array.from(ids);
    console.log(`\n  Syncing ${idsArray.length} ${modelName} records...`);

    try {
      const result = await syncPipelineData(modelName, {
        specificIds: idsArray,
        skipExisting: false,
        updateGraph: true,
      });

      console.log(`  ✓ ${modelName}: Synced ${result.uploaded}/${idsArray.length}`);
      totalSynced += result.uploaded;
    } catch (err) {
      console.error(`  ✗ ${modelName}: Failed - ${err}`);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log(`COMPLETE - Synced ${totalSynced} records`);
  console.log('='.repeat(70));
}

// Parse V2 data UUID: 00000002-MMMM-0000-0000-RRRRRRRRRRRR
function parseDataUuid(uuid: string): { modelId: number; recordId: number } | null {
  const parts = uuid.split('-');
  if (parts.length !== 5 || parts[0] !== '00000002') {
    return null;
  }

  const modelId = parseInt(parts[1], 10);
  const recordId = parseInt(parts[4], 10);

  if (isNaN(modelId) || isNaN(recordId)) {
    return null;
  }

  return { modelId, recordId };
}

main().catch(console.error);
