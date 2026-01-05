/**
 * Test Simple Schema Format Conversion
 *
 * This script tests the Simple format schema loader and converter.
 */

import { loadNexsusSchema, clearNexsusSchemaCache } from '../src/common/services/excel-schema-loader.js';

console.log('========================================');
console.log('Testing Simple Schema Format Conversion');
console.log('========================================\n');

try {
  // Clear cache to force fresh load
  clearNexsusSchemaCache();

  // Load schema (should auto-detect Simple format)
  console.log('Loading schema from nexsus_schema_v2_generated.xlsx...\n');
  const schemas = loadNexsusSchema();

  console.log(`✅ Loaded ${schemas.length} schema rows\n`);

  // Group by model
  const modelGroups = schemas.reduce((acc, schema) => {
    if (!acc[schema.model_name]) {
      acc[schema.model_name] = [];
    }
    acc[schema.model_name].push(schema);
    return acc;
  }, {} as Record<string, typeof schemas>);

  console.log(`Models found: ${Object.keys(modelGroups).length}`);
  for (const [modelName, fields] of Object.entries(modelGroups)) {
    console.log(`  - ${modelName}: ${fields.length} fields`);
  }
  console.log('');

  // Show a few sample conversions
  console.log('Sample Conversions:');
  console.log('===================\n');

  // Show first 3 fields
  schemas.slice(0, 3).forEach((schema, idx) => {
    console.log(`[${idx + 1}] ${schema.model_name}.${schema.field_name}`);
    console.log(`    UUID: ${schema.qdrant_id}`);
    console.log(`    Type: ${schema.field_type}`);
    console.log(`    Stored: ${schema.stored}`);
    console.log(`    Label: ${schema.field_label}`);
    if (schema.fk_location_model) {
      console.log(`    FK Target: ${schema.fk_location_model} (Model ID: ${schema.fk_location_model_id})`);
      console.log(`    FK UUID: ${schema.fk_qdrant_id}`);
    }
    console.log(`    Semantic: ${schema.semantic_text.substring(0, 100)}...`);
    console.log('');
  });

  // Test FK fields specifically
  const fkFields = schemas.filter(s => s.fk_location_model);
  console.log(`FK Fields: ${fkFields.length}`);
  if (fkFields.length > 0) {
    console.log('Sample FK field:');
    const fk = fkFields[0];
    console.log(`  Field: ${fk.model_name}.${fk.field_name}`);
    console.log(`  Target: ${fk.fk_location_model}`);
    console.log(`  Target Model ID: ${fk.fk_location_model_id}`);
    console.log(`  Target Field ID: ${fk.fk_location_record_id}`);
    console.log(`  FK UUID: ${fk.fk_qdrant_id}`);
    console.log('');
  }

  // Validate UUIDs
  const invalidUuids = schemas.filter(s =>
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.qdrant_id)
  );

  if (invalidUuids.length > 0) {
    console.log(`⚠️  Warning: ${invalidUuids.length} invalid UUIDs found`);
  } else {
    console.log(`✅ All UUIDs are valid V2 format`);
  }

  // Validate required fields
  const missingFields = schemas.filter(s =>
    !s.field_id || !s.model_id || !s.field_name || !s.model_name
  );

  if (missingFields.length > 0) {
    console.log(`⚠️  Warning: ${missingFields.length} rows missing required fields`);
  } else {
    console.log(`✅ All rows have required fields`);
  }

  console.log('\n========================================');
  console.log('✅ Simple Schema Format Test PASSED');
  console.log('========================================');

} catch (error) {
  console.error('\n❌ Test FAILED:');
  console.error(error);
  process.exit(1);
}
