/**
 * Verify UUID fixes after schema sync
 */

// Load environment variables FIRST (before any imports that use them)
import dotenv from 'dotenv';
dotenv.config();

import { initializeVectorClient, getQdrantClient } from '../src/common/services/vector-client.js';
import { UNIFIED_CONFIG } from '../src/common/constants.js';

async function verifyUUIDs() {
  console.log('========================================');
  console.log('UUID Verification');
  console.log('========================================\n');

  // Initialize vector client
  await initializeVectorClient();
  const client = getQdrantClient();

  // Test 1: country.name (field_id=202, model_id=2)
  console.log('=== Test 1: country.name (field_id=202, model_id=2) ===');
  const countryName = await client.retrieve(UNIFIED_CONFIG.COLLECTION_NAME, {
    ids: ['00000003-0002-0000-0000-000000000202'],
    with_payload: true,
    with_vector: false,
  });

  if (countryName.length > 0) {
    console.log('✅ UUID: ' + countryName[0].id);
    console.log('   Model ID:', countryName[0].payload.model_id);
    console.log('   Field Name:', countryName[0].payload.field_name);
    console.log('   Expected: 00000003-0002-0000-0000-000000000202');
    console.log('');
  } else {
    console.log('❌ Record not found with UUID: 00000003-0002-0000-0000-000000000202');
    console.log('');
  }

  // Test 2: customer.country_id (field_id=104, model_id=1) - FK field
  console.log('=== Test 2: customer.country_id (field_id=104, model_id=1) ===');
  const customerCountryId = await client.retrieve(UNIFIED_CONFIG.COLLECTION_NAME, {
    ids: ['00000003-0001-0000-0000-000000000104'],
    with_payload: true,
    with_vector: false,
  });

  if (customerCountryId.length > 0) {
    console.log('✅ UUID: ' + customerCountryId[0].id);
    console.log('   Model ID:', customerCountryId[0].payload.model_id);
    console.log('   Field Name:', customerCountryId[0].payload.field_name);
    console.log('   Field Type:', customerCountryId[0].payload.field_type);
    console.log('   Expected: 00000003-0001-0000-0000-000000000104');
    console.log('');

    const semanticText = customerCountryId[0].payload.semantic_text as string;
    console.log('Semantic Text (last 200 chars):');
    console.log('...' + semanticText.slice(-200));
    console.log('');

    // Check if FK UUID is in semantic text
    if (semanticText.includes('Qdrant ID for FK')) {
      console.log('✅ FK Qdrant ID found in semantic text!');
      const match = semanticText.match(/Qdrant ID for FK - ([0-9a-f-]+)/);
      if (match) {
        console.log('   FK UUID: ' + match[1]);
        console.log('   Expected: 00000003-0002-0000-0000-000000000201');
      }
    } else {
      console.log('❌ FK Qdrant ID NOT found in semantic text');
    }
    console.log('');
  } else {
    console.log('❌ Record not found with UUID: 00000003-0001-0000-0000-000000000104');
    console.log('');
  }

  console.log('========================================');
  console.log('Verification Complete');
  console.log('========================================');
}

verifyUUIDs().catch((error) => {
  console.error('❌ Verification failed:', error);
  process.exit(1);
});
