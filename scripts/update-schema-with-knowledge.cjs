/**
 * Update Schema Excel with Knowledge Levels
 *
 * This script adds:
 * 1. Extended columns (L-Q) to Schema sheet for Level 4 Field Knowledge
 * 2. New Model_Metadata sheet for Level 3
 * 3. New Instance_Config sheet for Level 2
 *
 * Run with: node scripts/update-schema-with-knowledge.cjs
 */

const XLSX = require('xlsx');
const path = require('path');

const EXCEL_PATH = path.join(__dirname, '..', 'samples', 'Nexsus1_schema.xlsx');

// =============================================================================
// INSTANCE CONFIG DATA (Level 2)
// =============================================================================

const instanceConfigData = [
  // Header row
  ['Config_Key', 'Config_Value', 'Config_Category', 'Description', 'Applies_To', 'LLM_Instruction', 'Last_Updated'],

  // Business Context
  ['COMPANY_NAME', 'DuraCube (The Almar Group)', 'operational', 'Legal entity name', 'all', 'Use this name when referencing the company in reports or analysis', '2025-01-07'],
  ['INDUSTRY', 'Manufacturing - Commercial Toilet Partitions', 'operational', 'Industry classification', 'all', 'Context for understanding revenue patterns and cost structures', '2025-01-07'],
  ['BUSINESS_UNIT', 'DuraCube Division', 'operational', 'Division within The Almar Group', 'all', 'This is one division of a larger group', '2025-01-07'],
  ['PRIMARY_USERS', 'Finance Team, Management', 'operational', 'Primary user groups', 'all', 'Tailor explanations for finance and management audiences', '2025-01-07'],
  ['BUSINESS_PURPOSE', 'Financial reporting and analysis', 'operational', 'Purpose of this data sync', 'all', 'Focus on financial accuracy and auditability', '2025-01-07'],

  // Financial Context
  ['FISCAL_YEAR_START', '2024-07-01', 'financial', 'Australian fiscal year start (July 1)', 'actual', 'FY2025 starts July 1, 2024. Use for period calculations.', '2025-01-07'],
  ['FISCAL_YEAR_END', '2025-06-30', 'financial', 'Australian fiscal year end (June 30)', 'actual', 'FY2025 ends June 30, 2025. Use for YTD calculations.', '2025-01-07'],
  ['DEFAULT_CURRENCY', 'AUD', 'financial', 'Australian Dollars', 'all', 'All amounts are in AUD. No currency conversion needed.', '2025-01-07'],
  ['DATE_FORMAT', 'Excel Serial', 'financial', 'Dates stored as Excel serial numbers', 'actual', 'Month field uses Excel serial dates (e.g., 45658 = Jan 1, 2025). Convert for display.', '2025-01-07'],

  // Technical Context
  ['SYNCED_MODELS', 'master,actual', 'technical', 'Models synced to Qdrant', 'all', 'Only master and actual are available. schema is for metadata only.', '2025-01-07'],
  ['PAYLOAD_ENABLED_MODELS', 'master,actual,country', 'technical', 'Models with nexsus_search support', 'nexsus_search', 'All synced models support nexsus_search with payload fields.', '2025-01-07'],
  ['DEFAULT_QUERY_LIMIT', '100', 'technical', 'Default record limit', 'nexsus_search', 'Return max 100 records by default to prevent overwhelming results', '2025-01-07'],
  ['EMBEDDING_MODEL', 'voyage-3.5-lite', 'technical', 'Voyage AI embedding model', 'all', 'Technical detail - not relevant for query building', '2025-01-07'],
  ['VECTOR_COLLECTION', 'nexsus1_unified', 'technical', 'Qdrant collection name', 'all', 'Technical detail - not relevant for query building', '2025-01-07'],

  // Limitations (CRITICAL for LLM accuracy)
  // NOTE: LIMITATION_ACTUAL_NO_PAYLOAD removed - all models now have payload fields configured
  // NOTE: LIMITATION_FK_NO_CASCADE removed - FK cascade is now working properly
  ['LIMITATION_DATES_SERIAL', 'Month field uses Excel serial dates', 'limitation', 'Dates need conversion for display', 'actual', 'Always convert Month values before showing to user. Use formula: date = (serial - 25569) * 86400 * 1000 for JS Date.', '2025-01-07'],

  // Common Query Patterns
  ['QUERY_PATTERN_REVENUE', 'F1 = "REV"', 'query', 'Filter for revenue accounts', 'master', 'To find revenue accounts, filter on F1="REV" in master model', '2025-01-07'],
  ['QUERY_PATTERN_EXPENSES', 'F1 IN ("VCOS", "FCOS", "OH")', 'query', 'Filter for expense accounts', 'master', 'Variable costs=VCOS, Fixed costs=FCOS, Overheads=OH', '2025-01-07'],
  ['QUERY_PATTERN_ENTITY', 'Entity field for segment analysis', 'query', 'Product, Installation, Freight, Other', 'master,actual', 'Entity field segments by business line. Use for segment reports.', '2025-01-07'],

  // Aggregation Rule (AUTO-DETECTED from schema Field_Type)
  // NOTE: AGGREGATION_SAFE_FIELDS removed - now auto-detected based on Field_Type
  ['AGGREGATION_RULE', 'Field_Type in (integer, float, monetary) = SUM/AVG safe', 'query', 'How to determine aggregation-safe fields', 'nexsus_search', 'Check Field_Type in schema. integer/float/monetary support SUM/AVG/MIN/MAX. date supports MIN/MAX only. Use getAggregationSafeFields() for programmatic access.', '2025-01-07'],
];

// =============================================================================
// MODEL METADATA DATA (Level 3)
// =============================================================================

const modelMetadataData = [
  // Header row
  ['Model_ID', 'Model_Name', 'Business_Name', 'Business_Purpose', 'Data_Grain', 'Record_Count', 'Is_Payload_Enabled', 'Primary_Use_Cases', 'Key_Relationships', 'LLM_Query_Guidance', 'Known_Issues', 'Last_Updated'],

  // Schema model (metadata only)
  [1, 'schema', 'Field Definitions', 'Stores field metadata for all models', 'One row per field definition', 48, 'No', 'Schema discovery, field lookups', 'None (reference only)', 'Use semantic_search with point_type="schema" to find fields. Not queryable with nexsus_search.', 'None', '2025-01-07'],

  // Master model (Chart of Accounts)
  [2, 'master', 'Chart of Accounts', 'GL account master data with classifications and hierarchies', 'One row per GL account code', 560, 'Yes', 'Account lookups, classification mapping, hierarchy navigation', 'actual.Account_id -> master.id', 'Use nexsus_search for precise lookups. Filter by F1 for P&L grouping (REV, VCOS, FCOS, OH). Use Entity for segment analysis.', 'Some DCFL fields are undocumented legacy classifications', '2025-01-07'],

  // Actual model (Monthly Actuals)
  [3, 'actual', 'Monthly Actuals', 'Monthly financial transactions by account and entity', 'One row per account/month/entity combination', 15000, 'Yes', 'Financial analysis, trend analysis, YTD calculations', 'Account_id -> master.id', 'Use nexsus_search for precise queries. Month is Excel serial date - convert before display. Amount is net (positive=debit).', 'Large dataset - use filters when possible. Month needs date conversion.', '2025-01-07'],
];

// =============================================================================
// FIELD KNOWLEDGE DATA (Level 4 - Extended Schema Columns)
// =============================================================================

// Field knowledge for key fields (L-Q columns in Schema sheet)
// Format: { Field_ID: { Field_Knowledge, Valid_Values, Data_Format, Calculation_Formula, Validation_Rules, LLM_Usage_Notes } }
const fieldKnowledge = {
  // Master model fields
  201: { // id
    Field_Knowledge: 'Unique GL account code identifier',
    Valid_Values: '10000-99999',
    Data_Format: '5-digit integer',
    Calculation_Formula: '',
    Validation_Rules: 'Must be unique, not null',
    LLM_Usage_Notes: 'Use for exact account lookups. This is the primary key.',
  },
  202: { // Gllinkname
    Field_Knowledge: 'Full account name including code prefix',
    Valid_Values: '',
    Data_Format: '"NNNNN Description" format',
    Calculation_Formula: '',
    Validation_Rules: '',
    LLM_Usage_Notes: 'Best field for semantic search. Contains both code and description.',
  },
  203: { // Type2
    Field_Knowledge: 'Statement type classification',
    Valid_Values: 'BS|PL',
    Data_Format: '2-character code',
    Calculation_Formula: '',
    Validation_Rules: 'Must be BS or PL',
    LLM_Usage_Notes: 'BS=Balance Sheet, PL=Profit & Loss. Use to filter by financial statement.',
  },
  204: { // F1
    Field_Knowledge: 'Level 1 P&L classification code',
    Valid_Values: 'REV|VCOS|FCOS|OH|CASH|OCA|FA|INT|CL|LTL|EQ',
    Data_Format: '2-4 character code',
    Calculation_Formula: '',
    Validation_Rules: '',
    LLM_Usage_Notes: 'Primary P&L grouping. REV=Revenue, VCOS=Variable Costs, FCOS=Fixed Costs, OH=Overhead. BS codes: CASH, OCA, FA, INT, CL, LTL, EQ.',
  },
  205: { // F1_des
    Field_Knowledge: 'Level 1 classification description',
    Valid_Values: 'Cash on Hand|Other Current Assets|Fixed Assets|...',
    Data_Format: 'Text description',
    Calculation_Formula: '',
    Validation_Rules: '',
    LLM_Usage_Notes: 'Human-readable version of F1 code. Use in reports.',
  },
  212: { // Entity
    Field_Knowledge: 'Business segment classification',
    Valid_Values: 'Product|Installation|Freight|Other',
    Data_Format: 'Text',
    Calculation_Formula: '',
    Validation_Rules: '',
    LLM_Usage_Notes: 'Use for segment analysis. Product=manufacturing, Installation=services, Freight=logistics.',
  },
  213: { // EBITA
    Field_Knowledge: 'EBITA inclusion flag',
    Valid_Values: 'Y|N',
    Data_Format: 'Y/N flag',
    Calculation_Formula: '',
    Validation_Rules: '',
    LLM_Usage_Notes: 'Y=include in EBITA calculations. Filter EBITA="Y" for EBITA reports.',
  },

  // Actual model fields
  301: { // id
    Field_Knowledge: 'Unique transaction row identifier',
    Valid_Values: '1-999999',
    Data_Format: 'Auto-increment integer',
    Calculation_Formula: '',
    Validation_Rules: 'Must be unique, not null',
    LLM_Usage_Notes: 'Row identifier only. Not meaningful for analysis.',
  },
  302: { // Account_id
    Field_Knowledge: 'Foreign key to master.id (GL account)',
    Valid_Values: 'Valid master.id values',
    Data_Format: '5-digit integer',
    Calculation_Formula: '',
    Validation_Rules: 'Must exist in master.id',
    LLM_Usage_Notes: 'Links to Chart of Accounts. Use graph_traverse to navigate to master.',
  },
  304: { // Month
    Field_Knowledge: 'Accounting period (first day of month)',
    Valid_Values: '44562-46023',
    Data_Format: 'Excel serial date',
    Calculation_Formula: 'JS Date: new Date((serial - 25569) * 86400 * 1000)',
    Validation_Rules: 'Must be valid Excel date',
    LLM_Usage_Notes: 'CRITICAL: Convert before displaying! 44562=Jul 2021, 45658=Jan 2025. FY2025=45474-45838.',
  },
  305: { // Entity
    Field_Knowledge: 'Business segment for this transaction',
    Valid_Values: 'Product|Installation|Freight|Other',
    Data_Format: 'Text',
    Calculation_Formula: '',
    Validation_Rules: '',
    LLM_Usage_Notes: 'Same segments as master. Use for segment P&L analysis.',
  },
  306: { // Classification
    Field_Knowledge: 'Account classification code',
    Valid_Values: 'Various codes',
    Data_Format: 'Text code',
    Calculation_Formula: '',
    Validation_Rules: '',
    LLM_Usage_Notes: 'Short classification code. Use F1 from master for standard grouping.',
  },
  308: { // Amount
    Field_Knowledge: 'Net transaction amount for the period',
    Valid_Values: 'Any decimal',
    Data_Format: 'Decimal (AUD)',
    Calculation_Formula: '',
    Validation_Rules: 'Numeric',
    LLM_Usage_Notes: 'Positive=debit, negative=credit. SUM for totals. All values in AUD.',
  },
};

// =============================================================================
// MAIN SCRIPT
// =============================================================================

function main() {
  console.log('Loading existing workbook...');
  const workbook = XLSX.readFile(EXCEL_PATH);

  // Get existing Schema sheet data - handle both 'Sheet1' and 'Schema' names
  let schemaSheetName = workbook.SheetNames.find(name => name === 'Schema' || name === 'Sheet1');
  if (!schemaSheetName) {
    console.error('ERROR: Could not find Schema or Sheet1 sheet');
    process.exit(1);
  }
  console.log(`Using sheet: ${schemaSheetName}`);

  const schemaSheet = workbook.Sheets[schemaSheetName];
  const schemaData = XLSX.utils.sheet_to_json(schemaSheet, { header: 1 });

  console.log(`Found ${schemaData.length - 1} schema rows`);

  // Add Level 4 columns to header (columns L-Q)
  const headers = schemaData[0];
  const newHeaders = [
    'Field_Knowledge',     // L (column 12)
    'Valid_Values',        // M (column 13)
    'Data_Format',         // N (column 14)
    'Calculation_Formula', // O (column 15)
    'Validation_Rules',    // P (column 16)
    'LLM_Usage_Notes',     // Q (column 17)
  ];

  // Extend headers
  const extendedHeaders = [...headers, ...newHeaders];
  schemaData[0] = extendedHeaders;

  // Add field knowledge to rows
  let knowledgeAdded = 0;
  for (let i = 1; i < schemaData.length; i++) {
    const row = schemaData[i];
    const fieldId = row[0]; // Field_ID is first column

    if (fieldKnowledge[fieldId]) {
      const fk = fieldKnowledge[fieldId];
      row[11] = fk.Field_Knowledge || '';
      row[12] = fk.Valid_Values || '';
      row[13] = fk.Data_Format || '';
      row[14] = fk.Calculation_Formula || '';
      row[15] = fk.Validation_Rules || '';
      row[16] = fk.LLM_Usage_Notes || '';
      knowledgeAdded++;
    } else {
      // Extend row with empty values
      while (row.length < 17) {
        row.push('');
      }
    }
  }

  console.log(`Added field knowledge to ${knowledgeAdded} fields`);

  // Create new Schema sheet with extended data
  const newSchemaSheet = XLSX.utils.aoa_to_sheet(schemaData);

  // Handle Schema sheet naming
  if (schemaSheetName === 'Sheet1') {
    // Rename Sheet1 to Schema
    delete workbook.Sheets['Sheet1'];
    const sheetIndex = workbook.SheetNames.indexOf('Sheet1');
    workbook.SheetNames[sheetIndex] = 'Schema';
  } else {
    // Schema sheet already exists, just replace it
    delete workbook.Sheets['Schema'];
  }
  workbook.Sheets['Schema'] = newSchemaSheet;

  // Create/replace Instance_Config sheet
  console.log('Creating Instance_Config sheet...');
  const instanceConfigSheet = XLSX.utils.aoa_to_sheet(instanceConfigData);
  if (!workbook.SheetNames.includes('Instance_Config')) {
    workbook.SheetNames.push('Instance_Config');
  }
  workbook.Sheets['Instance_Config'] = instanceConfigSheet;
  console.log(`Added ${instanceConfigData.length - 1} instance config rows`);

  // Create/replace Model_Metadata sheet
  console.log('Creating Model_Metadata sheet...');
  const modelMetadataSheet = XLSX.utils.aoa_to_sheet(modelMetadataData);
  if (!workbook.SheetNames.includes('Model_Metadata')) {
    workbook.SheetNames.push('Model_Metadata');
  }
  workbook.Sheets['Model_Metadata'] = modelMetadataSheet;
  console.log(`Added ${modelMetadataData.length - 1} model metadata rows`);

  // Write the updated workbook
  console.log('\nWriting updated workbook...');
  XLSX.writeFile(workbook, EXCEL_PATH);

  console.log('\n=== SUCCESS ===');
  console.log(`Updated: ${EXCEL_PATH}`);
  console.log(`Sheets: ${workbook.SheetNames.join(', ')}`);
  console.log(`\nLevel 2 (Instance_Config): ${instanceConfigData.length - 1} rows`);
  console.log(`Level 3 (Model_Metadata): ${modelMetadataData.length - 1} rows`);
  console.log(`Level 4 (Field Knowledge): ${knowledgeAdded} fields with knowledge`);
}

main();
