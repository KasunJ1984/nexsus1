/**
 * Verify Schema UUIDs After Fix
 *
 * Checks that schema UUIDs now use correct model_id instead of hardcoded 0004
 */

// Load environment variables FIRST
import dotenv from 'dotenv';
dotenv.config();

import { initializeVectorClient, getQdrantClient } from '../src/common/services/vector-client.js';
import { UNIFIED_CONFIG } from '../src/common/constants.js';

async function verifySchemaUUIDs() {
  console.log('========================================');
  console.log('Schema UUID Verification');
  console.log('========================================\n');

  // Initialize vector client
  await initializeVectorClient();
  const client = getQdrantClient();

  const tests = [
    {
      name: 'customer.id (field_id=201, model_id=2)',
      uuid: '00000003-0002-0000-0000-000000000201',
      expectedModel: 2,
      expectedField: 'id',
    },
    {
      name: 'customer.country_id (field_id=204, model_id=2, FK field)',
      uuid: '00000003-0002-0000-0000-000000000204',
      expectedModel: 2,
      expectedField: 'country_id',
      checkFkUuid: true,
      expectedFkUuid: '00000003-0003-0000-0000-000000000301',
    },
    {
      name: 'country.name (field_id=302, model_id=3)',
      uuid: '00000003-0003-0000-0000-000000000302',
      expectedModel: 3,
      expectedField: 'name',
    },
  ];

  for (const test of tests) {
    console.log(`=== Test: ${test.name} ===`);

    try {
      const result = await client.retrieve(UNIFIED_CONFIG.COLLECTION_NAME, {
        ids: [test.uuid],
        with_payload: true,
        with_vector: false,
      });

      if (result.length === 0) {
        console.log(`❌ Record not found with UUID: ${test.uuid}`);
        console.log('');
        continue;
      }

      const record = result[0];
      console.log('✅ Record found!');
      console.log(`   UUID: ${record.id}`);
      console.log(`   Model ID: ${record.payload.model_id}`);
      console.log(`   Field Name: ${record.payload.field_name}`);
      console.log(`   Model Name: ${record.payload.model_name}`);

      // Verify model_id is correct
      if (record.payload.model_id === test.expectedModel) {
        console.log(`✅ Model ID correct: ${test.expectedModel}`);
      } else {
        console.log(`❌ Model ID wrong: expected ${test.expectedModel}, got ${record.payload.model_id}`);
      }

      // Check FK UUID in semantic text if this is a FK field
      if (test.checkFkUuid) {
        const semanticText = record.payload.semantic_text as string;
        if (semanticText.includes('Qdrant ID for FK')) {
          console.log('✅ FK Qdrant ID found in semantic text!');
          const match = semanticText.match(/Qdrant ID for FK - ([0-9a-f-]+)/);
          if (match) {
            const fkUuid = match[1];
            console.log(`   FK UUID: ${fkUuid}`);
            if (fkUuid === test.expectedFkUuid) {
              console.log(`✅ FK UUID correct: ${test.expectedFkUuid}`);
            } else {
              console.log(`❌ FK UUID wrong: expected ${test.expectedFkUuid}, got ${fkUuid}`);
            }
          }
        } else {
          console.log('❌ FK Qdrant ID NOT found in semantic text');
        }
      }

      console.log('');
    } catch (error) {
      console.log(`❌ Error checking ${test.uuid}:`, error);
      console.log('');
    }
  }

  console.log('========================================');
  console.log('Verification Complete');
  console.log('========================================');
}

verifySchemaUUIDs().catch((error) => {
  console.error('❌ Verification failed:', error);
  process.exit(1);
});
