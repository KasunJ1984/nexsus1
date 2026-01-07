/**
 * Simple UUID verification using direct API calls
 */

require('dotenv').config();
const https = require('https');

const QDRANT_HOST = process.env.QDRANT_HOST || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';
const COLLECTION = process.env.UNIFIED_COLLECTION_NAME || 'nexsus1_unified';

console.log('========================================');
console.log('UUID Verification');
console.log('========================================\n');
console.log('Connecting to:', QDRANT_HOST);
console.log('Collection:', COLLECTION);
console.log('');

const agent = new https.Agent({ rejectUnauthorized: false });

function fetchPoints(ids) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${QDRANT_HOST}/collections/${COLLECTION}/points`);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': QDRANT_API_KEY
      },
      agent: agent
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify({
      ids: ids,
      with_payload: true,
      with_vector: false
    }));
    req.end();
  });
}

async function verify() {
  try {
    // Test 1: country.name
    console.log('=== Test 1: country.name (field_id=202, model_id=2) ===');
    const result1 = await fetchPoints(['00000003-0002-0000-0000-000000000202']);

    if (result1.result && result1.result.length > 0) {
      const point = result1.result[0];
      console.log('✅ UUID:', point.id);
      console.log('   Model ID:', point.payload.model_id);
      console.log('   Field Name:', point.payload.field_name);
      console.log('   Expected: 00000003-0002-0000-0000-000000000202');
      console.log('');
    } else {
      console.log('❌ Record not found with UUID: 00000003-0002-0000-0000-000000000202');
      console.log('');
    }

    // Test 2: customer.country_id
    console.log('=== Test 2: customer.country_id (field_id=104, model_id=1) ===');
    const result2 = await fetchPoints(['00000003-0001-0000-0000-000000000104']);

    if (result2.result && result2.result.length > 0) {
      const point = result2.result[0];
      console.log('✅ UUID:', point.id);
      console.log('   Model ID:', point.payload.model_id);
      console.log('   Field Name:', point.payload.field_name);
      console.log('   Field Type:', point.payload.field_type);
      console.log('   Expected: 00000003-0001-0000-0000-000000000104');
      console.log('');

      const semanticText = point.payload.semantic_text;
      console.log('Semantic Text (last 250 chars):');
      console.log('...' + semanticText.slice(-250));
      console.log('');

      if (semanticText.includes('Qdrant ID for FK')) {
        console.log('✅ FK Qdrant ID found in semantic text!');
        const match = semanticText.match(/Qdrant ID for FK - ([0-9a-f-]+)/);
        if (match) {
          console.log('   FK UUID:', match[1]);
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

  } catch (error) {
    console.error('❌ Verification failed:', error.message);
    process.exit(1);
  }
}

verify();
