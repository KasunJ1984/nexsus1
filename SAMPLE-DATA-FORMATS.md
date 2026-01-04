# Nexsus1 Data Formats - Sample Templates

This document explains the required format for schema, data, and payload configuration files.

---

## 1. Schema File Format

**File:** `nexsus_schema_v2_generated.xlsx`
**Sheet Name:** `Schema`

### Required Columns:

| Column | Description | Example |
|--------|-------------|---------|
| **Qdrant ID** | V2 UUID format | `00000003-0004-0000-0000-000000005012` |
| **Vector** | Text to embed | `In model ir.model.fields ,Field_ID - 5012, Model_ID - 292, Field_Name - name, Field_Label - Account Name, Field_Type - char, Model_Name - account.account, Stored - Yes` |
| **Payload** | Structured metadata | `point_id - 00000003-0004-0000-0000-000000005012, Data_type - 3, Field_ID - 5012, Model_ID - 292, Field_Name - name, Field_Label - Account Name, Field_Type - char, Model_Name - account.account, Stored - Yes` |

### Sample Schema Rows:

```
Qdrant ID                                    | Vector                                                                                                                                                              | Payload
00000003-0004-0000-0000-000000005012        | In model ir.model.fields ,Field_ID - 5012, Model_ID - 292, Field_Name - name, Field_Label - Account Name, Field_Type - char, Model_Name - account.account, Stored - Yes | point_id - 00000003-0004-0000-0000-000000005012, Data_type - 3, Field_ID - 5012, Model_ID - 292, Field_Name - name, Field_Label - Account Name, Field_Type - char, Model_Name - account.account, Stored - Yes
00000003-0004-0000-0000-000000005013        | In model ir.model.fields ,Field_ID - 5013, Model_ID - 292, Field_Name - currency_id, Field_Label - Account Currency, Field_Type - many2one, Model_Name - account.account, Stored - Yes | point_id - 00000003-0004-0000-0000-000000005013, Data_type - 3, Field_ID - 5013, Model_ID - 292, Field_Name - currency_id, Field_Label - Account Currency, Field_Type - many2one, Model_Name - account.account, Stored - Yes
```

### UUID Format for Schema:
- **Pattern:** `00000003-0004-0000-0000-{FIELD_ID}`
- `00000003` = Schema namespace
- `0004` = Fixed (ir.model.fields identifier)
- `{FIELD_ID}` = 12-digit field ID (padded with leading zeros)

**Example:** Field ID 5012 → `00000003-0004-0000-0000-000000005012`

---

## 2. Data File Format

**Location:** `data/excel/*.xlsx`
**Sheet Name:** `Data` (first sheet)

### Structure:
- **First row:** Column headers (field names)
- **Subsequent rows:** Actual data records

### Required Conventions:

1. **Field Names:** Use exact field names from your schema
2. **FK Fields:** Include both display value and ID
   - Display: `state_id` (shows "New South Wales (AU)")
   - ID: `state_id_id` (shows numeric ID like 2)
3. **ID Column:** Required for generating V2 UUIDs

### Sample Data Format (res.partner):

| id | name | city | state_id | state_id_id | country_id |
|----|------|------|----------|-------------|------------|
| 1 | Duracube | Emu Plains | New South Wales (AU) | 2 | Australia |
| 2 | Ben Simpson | Emu Plains | New South Wales (AU) | 2 | Australia |
| 3 | ACME Corp | Sydney | New South Wales (AU) | 2 | Australia |

### Sample Data Format (account.move.line):

| id | move_id | move_id_id | account_id | account_id_id | partner_id | partner_id_id | date | debit | credit | balance |
|----|---------|------------|------------|---------------|------------|---------------|------|-------|--------|---------|
| 1001 | INV/2025/0001 | 5001 | 4000 Revenue | 319 | Duracube | 1 | 2025-01-15 | 0.00 | 1500.00 | -1500.00 |
| 1002 | INV/2025/0001 | 5001 | 1200 Debtors | 45 | Duracube | 1 | 2025-01-15 | 1500.00 | 0.00 | 1500.00 |

### Important Notes:

- **ID is mandatory** - Used to generate V2 UUID
- **FK fields need both** display name and ID (e.g., `partner_id` and `partner_id_id`)
- **Empty values** should be blank cells, not "null" or "N/A"
- **Dates** should be in ISO format: YYYY-MM-DD
- **Numbers** should be numeric values, not text

### UUID Format for Data:
- **Pattern:** `00000002-{MODEL_ID}-0000-0000-{RECORD_ID}`
- `00000002` = Data namespace
- `{MODEL_ID}` = 4-digit model ID (e.g., 0078 for res.partner)
- `{RECORD_ID}` = 12-digit record ID (from `id` column)

**Example:** res.partner (model 78) record 286798 → `00000002-0078-0000-0000-000000286798`

---

## 3. Payload Fields Configuration

**File:** `feilds_to_add_payload.xlsx`
**Sheet Name:** `Sheet1`

### Required Columns:

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| **Field_ID** | Number | Unique field identifier | 28105 |
| **Model_ID** | Number | Model identifier | 292 |
| **Model_Name** | Text | Model technical name | account.account |
| **Field_Name** | Text | Field technical name | account_type |
| **Field_Label** | Text | Field display label | Type |
| **payload** | Boolean | Include in payload? | TRUE/FALSE |

### Sample Payload Configuration:

```
Field_ID | Model_ID | Model_Name      | Field_Name    | Field_Label           | payload
---------|----------|-----------------|---------------|-----------------------|--------
28105    | 292      | account.account | account_type  | Type                  | TRUE
5012     | 292      | account.account | name          | Account Name          | TRUE
5013     | 292      | account.account | currency_id   | Account Currency      | TRUE
5014     | 292      | account.account | code          | Code                  | TRUE
51556    | 292      | account.account | activity_date | Next Activity Deadline| (blank or FALSE)
```

### What is Payload?

**Payload = Fields stored in Qdrant alongside the vector**

- `payload: TRUE` → Field values stored in Qdrant for filtering/retrieval
- `payload: FALSE` or blank → Field only used for vector embedding, not stored

**When to set payload=TRUE:**
- Fields you'll filter on (dates, status, types)
- Fields you'll display in results (names, amounts)
- Foreign key IDs for relationships
- Critical metadata fields

**When to leave payload blank/FALSE:**
- Description fields (already in vector)
- Rarely queried fields
- Large text fields (to save storage)

### Example Use Case:

```excel
# These fields should be in payload for filtering and display:
Field_Name        | payload | Reason
------------------|---------|------------------------------------------
date              | TRUE    | Filter by date range
partner_id_id     | TRUE    | Filter by partner
account_id_id     | TRUE    | Filter by account
debit             | TRUE    | Show in results, aggregate
credit            | TRUE    | Show in results, aggregate
balance           | TRUE    | Show in results
name              | TRUE    | Show description in results

# These can be excluded from payload (only in vector):
Field_Name        | payload | Reason
------------------|---------|------------------------------------------
narration         | FALSE   | Long text, already embedded
notes             | FALSE   | Rarely queried
computed_field    | FALSE   | Can be calculated
```

---

## 4. Creating Your Own Data Files

### Step 1: Create Schema File

**Template: schema.xlsx**

```excel
Sheet: Schema
Columns: Qdrant ID | Vector | Payload

Row 1 (Header):
Qdrant ID | Vector | Payload

Row 2 (Field 1):
00000003-0004-0000-0000-000000000001 | In model mymodel, Field_ID - 1, Model_ID - 1, Field_Name - id, Field_Label - ID, Field_Type - integer, Model_Name - my.model, Stored - Yes | point_id - 00000003-0004-0000-0000-000000000001, Data_type - 3, Field_ID - 1, Model_ID - 1, Field_Name - id, Field_Label - ID, Field_Type - integer, Model_Name - my.model, Stored - Yes

Row 3 (Field 2):
00000003-0004-0000-0000-000000000002 | In model mymodel, Field_ID - 2, Model_ID - 1, Field_Name - name, Field_Label - Name, Field_Type - char, Model_Name - my.model, Stored - Yes | point_id - 00000003-0004-0000-0000-000000000002, Data_type - 3, Field_ID - 2, Model_ID - 1, Field_Name - name, Field_Label - Name, Field_Type - char, Model_Name - my.model, Stored - Yes
```

### Step 2: Create Data File

**Template: data/excel/my_model_data.xlsx**

```excel
Sheet: Data
Columns: id | name | email | status | created_date

Row 1 (Header):
id | name | email | status | created_date

Row 2:
1 | John Doe | john@example.com | active | 2025-01-01

Row 3:
2 | Jane Smith | jane@example.com | active | 2025-01-02
```

### Step 3: Create Payload Config

**Template: feilds_to_add_payload.xlsx**

```excel
Sheet: Sheet1
Columns: Field_ID | Model_ID | Model_Name | Field_Name | Field_Label | payload

Row 1 (Header):
Field_ID | Model_ID | Model_Name | Field_Name | Field_Label | payload

Row 2:
1 | 1 | my.model | id | ID | TRUE

Row 3:
2 | 1 | my.model | name | Name | TRUE

Row 4:
3 | 1 | my.model | email | Email | TRUE

Row 5:
4 | 1 | my.model | status | Status | TRUE

Row 6:
5 | 1 | my.model | created_date | Created Date | TRUE
```

---

## 5. Syncing Your Data

### Commands:

```bash
# 1. Sync schema first (one-time)
npm run sync -- sync schema

# 2. Sync data (per model)
npm run sync -- sync model my.model

# 3. Check status
npm run sync -- status
```

### Full Workflow:

```bash
# Step 1: Place files in correct locations
# - nexsus_schema_v2_generated.xlsx → Root directory
# - feilds_to_add_payload.xlsx → Root directory
# - my_model_data.xlsx → data/excel/

# Step 2: Build
npm run build

# Step 3: Sync schema
npm run sync -- sync schema

# Step 4: Sync data
npm run sync -- sync model my.model

# Step 5: Verify via MCP tools (in Claude Desktop)
# - semantic_search with query: "search my model"
# - nexsus_search with filters
# - system_status to check counts
```

---

## 6. Quick Reference

### File Locations:

| File | Location | Purpose |
|------|----------|---------|
| Schema | `nexsus_schema_v2_generated.xlsx` | Field definitions |
| Data | `data/excel/*.xlsx` | Actual records |
| Payload Config | `feilds_to_add_payload.xlsx` | Which fields to store |

### UUID Namespaces:

| Type | Namespace | Example |
|------|-----------|---------|
| Schema | 00000003 | `00000003-0004-0000-0000-000000005012` |
| Data | 00000002 | `00000002-0078-0000-0000-000000286798` |
| Graph | 00000001 | `00000001-0312-0078-0031-000000005012` |

### Key Field Conventions:

| Convention | Example | Purpose |
|------------|---------|---------|
| Display field | `partner_id` | Human-readable name |
| ID field | `partner_id_id` | Numeric foreign key |
| Date field | `date` | ISO format YYYY-MM-DD |
| Boolean field | `active` | TRUE/FALSE |

---

## Need Help?

See the existing files in your Nexsus1 directory:
- `nexsus_schema_v2_generated.xlsx` - Real schema example
- `data/exports/nexsus_export_res_partner_*.xlsx` - Real data example
- `feilds_to_add_payload.xlsx` - Real payload config

Or check the documentation:
- `README.md` - General overview
- `CLAUDE.md` - Technical details
- `README-MCP-SETUP.md` - MCP server setup
