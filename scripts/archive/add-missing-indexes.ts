/**
 * Add Missing Payload Indexes
 *
 * Adds any missing indexes to the unified collection without re-syncing data.
 * Run this after adding new fields to UNIFIED_INDEXES in vector-client.ts.
 *
 * Usage: npx tsx scripts/add-missing-indexes.ts
 */

// IMPORTANT: This import MUST be first - it loads .env before other imports
import 'dotenv/config';

import { initializeVectorClient, addMissingPayloadIndexes } from '../src/common/services/vector-client.js';

async function main() {
  console.log('='.repeat(60));
  console.log('Add Missing Payload Indexes');
  console.log('='.repeat(60));
  console.log();

  // Initialize vector client
  console.log('Initializing vector client...');
  const initialized = initializeVectorClient();

  if (!initialized) {
    console.error('Failed to initialize vector client. Check QDRANT_HOST and QDRANT_API_KEY.');
    process.exit(1);
  }

  console.log('Vector client initialized.');
  console.log();

  // Add missing indexes
  console.log('Adding missing indexes...');
  console.log();

  const result = await addMissingPayloadIndexes();

  console.log();
  console.log('='.repeat(60));
  console.log('Results');
  console.log('='.repeat(60));
  console.log(`  Indexes added:   ${result.added}`);
  console.log(`  Indexes skipped: ${result.skipped} (already exist)`);
  console.log(`  Errors:          ${result.errors.length}`);

  if (result.errors.length > 0) {
    console.log();
    console.log('Errors:');
    for (const error of result.errors) {
      console.log(`  - ${error}`);
    }
  }

  console.log();
  console.log('Done!');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
