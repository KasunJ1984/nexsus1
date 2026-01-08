/**
 * Delete Qdrant Collection
 * Use this to reset a collection that has the wrong schema
 */

import dotenv from 'dotenv';
import { QdrantClient } from '@qdrant/js-client-rest';

// Load environment variables
dotenv.config();

const QDRANT_HOST = process.env.QDRANT_HOST || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';
const COLLECTION_NAME = process.env.UNIFIED_COLLECTION_NAME || 'nexsus1_unified';

console.log('========================================');
console.log('Deleting Qdrant Collection');
console.log('========================================\n');
console.log(`Host: ${QDRANT_HOST}`);
console.log(`Collection: ${COLLECTION_NAME}\n`);

async function deleteCollection() {
  const client = new QdrantClient({
    url: QDRANT_HOST,
    apiKey: QDRANT_API_KEY,
  });

  try {
    // Check if collection exists
    const collections = await client.getCollections();
    const exists = collections.collections.some(c => c.name === COLLECTION_NAME);

    if (!exists) {
      console.log(`✅ Collection "${COLLECTION_NAME}" does not exist. Nothing to delete.`);
      return;
    }

    console.log(`🗑️  Deleting collection "${COLLECTION_NAME}"...`);
    await client.deleteCollection(COLLECTION_NAME);
    console.log(`✅ Collection deleted successfully!\n`);
    console.log('You can now run: npm run sync -- sync schema');

  } catch (error) {
    console.error('❌ Error deleting collection:');
    console.error(error);
    process.exit(1);
  }
}

deleteCollection();
