import XLSX from 'xlsx';
import * as fs from 'fs';

// Create samples directory
if (!fs.existsSync('samples')) {
  fs.mkdirSync('samples');
}

// ===== 1. SAMPLE SCHEMA =====
const schemaData = [
  ['Qdrant ID', 'Vector', 'Payload'],
  [
    '00000003-0004-0000-0000-000000000001',
    'In model customer ,Field_ID - 1, Model_ID - 1, Field_Name - id, Field_Label - ID, Field_Type - integer, Model_Name - customer, Stored - Yes',
    'point_id - 00000003-0004-0000-0000-000000000001, Data_type - 3, Field_ID - 1, Model_ID - 1, Field_Name - id, Field_Label - ID, Field_Type - integer, Model_Name - customer, Stored - Yes'
  ],
  [
    '00000003-0004-0000-0000-000000000002',
    'In model customer ,Field_ID - 2, Model_ID - 1, Field_Name - name, Field_Label - Customer Name, Field_Type - char, Model_Name - customer, Stored - Yes',
    'point_id - 00000003-0004-0000-0000-000000000002, Data_type - 3, Field_ID - 2, Model_ID - 1, Field_Name - name, Field_Label - Customer Name, Field_Type - char, Model_Name - customer, Stored - Yes'
  ],
  [
    '00000003-0004-0000-0000-000000000003',
    'In model customer ,Field_ID - 3, Model_ID - 1, Field_Name - email, Field_Label - Email, Field_Type - char, Model_Name - customer, Stored - Yes',
    'point_id - 00000003-0004-0000-0000-000000000003, Data_type - 3, Field_ID - 3, Model_ID - 1, Field_Name - email, Field_Label - Email, Field_Type - char, Model_Name - customer, Stored - Yes'
  ],
  [
    '00000003-0004-0000-0000-000000000004',
    'In model customer ,Field_ID - 4, Model_ID - 1, Field_Name - country_id, Field_Label - Country, Field_Type - many2one, Model_Name - customer, FK location field model - country, FK location field model id - 2, Stored - Yes',
    'point_id - 00000003-0004-0000-0000-000000000004, Data_type - 3, Field_ID - 4, Model_ID - 1, Field_Name - country_id, Field_Label - Country, Field_Type - many2one, Model_Name - customer, Stored - Yes, FK location field model - country, FK location field model id - 2'
  ],
  [
    '00000003-0004-0000-0000-000000000005',
    'In model customer ,Field_ID - 5, Model_ID - 1, Field_Name - status, Field_Label - Status, Field_Type - selection, Model_Name - customer, Stored - Yes',
    'point_id - 00000003-0004-0000-0000-000000000005, Data_type - 3, Field_ID - 5, Model_ID - 1, Field_Name - status, Field_Label - Status, Field_Type - selection, Model_Name - customer, Stored - Yes'
  ],
  [
    '00000003-0004-0000-0000-000000000006',
    'In model customer ,Field_ID - 6, Model_ID - 1, Field_Name - created_date, Field_Label - Created Date, Field_Type - date, Model_Name - customer, Stored - Yes',
    'point_id - 00000003-0004-0000-0000-000000000006, Data_type - 3, Field_ID - 6, Model_ID - 1, Field_Name - created_date, Field_Label - Created Date, Field_Type - date, Model_Name - customer, Stored - Yes'
  ]
];

const schemaWs = XLSX.utils.aoa_to_sheet(schemaData);
const schemaWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(schemaWb, schemaWs, 'Schema');
XLSX.writeFile(schemaWb, 'samples/SAMPLE_schema.xlsx');
console.log('✅ Created: samples/SAMPLE_schema.xlsx');

// ===== 2. SAMPLE DATA =====
const dataData = [
  ['id', 'name', 'email', 'country_id', 'country_id_id', 'status', 'created_date'],
  [1, 'Acme Corporation', 'contact@acme.com', 'Australia', 1, 'active', '2025-01-01'],
  [2, 'TechStart Inc', 'hello@techstart.io', 'United States', 2, 'active', '2025-01-05'],
  [3, 'Global Solutions Ltd', 'info@globalsolutions.com', 'United Kingdom', 3, 'active', '2025-01-10'],
  [4, 'Innovation Partners', 'partners@innovation.com', 'Australia', 1, 'pending', '2025-01-15'],
  [5, 'Digital Ventures', 'team@digitalventures.com', 'Canada', 4, 'active', '2025-01-20']
];

const dataWs = XLSX.utils.aoa_to_sheet(dataData);
const dataWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(dataWb, dataWs, 'Data');
XLSX.writeFile(dataWb, 'samples/SAMPLE_customer_data.xlsx');
console.log('✅ Created: samples/SAMPLE_customer_data.xlsx');

// ===== 3. SAMPLE PAYLOAD CONFIG =====
const payloadData = [
  ['Field_ID', 'Model_ID', 'Model_Name', 'Field_Name', 'Field_Label', 'payload'],
  [1, 1, 'customer', 'id', 'ID', true],
  [2, 1, 'customer', 'name', 'Customer Name', true],
  [3, 1, 'customer', 'email', 'Email', true],
  [4, 1, 'customer', 'country_id', 'Country', true],
  [5, 1, 'customer', 'status', 'Status', true],
  [6, 1, 'customer', 'created_date', 'Created Date', true]
];

const payloadWs = XLSX.utils.aoa_to_sheet(payloadData);
const payloadWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(payloadWb, payloadWs, 'Sheet1');
XLSX.writeFile(payloadWb, 'samples/SAMPLE_payload_config.xlsx');
console.log('✅ Created: samples/SAMPLE_payload_config.xlsx');

console.log('\n📂 All sample templates created in samples/ directory');
console.log('\nNext steps:');
console.log('1. Edit these files with your actual data');
console.log('2. Rename them (remove SAMPLE_ prefix)');
console.log('3. Place them in correct locations:');
console.log('   - schema → nexsus_schema_v2_generated.xlsx (root)');
console.log('   - data → data/excel/your_model_data.xlsx');
console.log('   - payload → feilds_to_add_payload.xlsx (root)');
console.log('4. Run: npm run sync -- sync schema');
console.log('5. Run: npm run sync -- sync model customer');
