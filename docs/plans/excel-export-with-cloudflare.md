# Excel Export with Cloudflare R2

## Overview

Add automatic Excel export with Cloudflare R2 cloud storage when query results exceed 10,000 tokens. This enables Claude.ai users to download large result sets that would otherwise overflow the context window.

**Problem:** MCP server runs on Railway - local filesystem exports are inaccessible to Claude.ai users.

**Solution:** Upload Excel files to Cloudflare R2 and return signed download URLs (1-hour expiry).

**Scope:** 6 data-returning tools: `nexsus_search`, `semantic_search`, `find_similar`, `graph_traverse`, `inspect_record`, `system_status`

---

## Stages

### Stage 1: R2 Client Infrastructure
**Goal:** Create the Cloudflare R2 integration foundation
**Estimated effort:** Medium (2 hours)

**Tasks:**
- [ ] Install AWS SDK dependencies: `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`
- [ ] Create `src/common/services/r2-client.ts` with:
  - `isR2Enabled()` - check if R2 env vars are configured
  - `getR2Client()` - singleton S3Client for R2
  - `uploadToR2(buffer, filename, contentType)` - upload file and return key
  - `getSignedDownloadUrl(key, expiresIn)` - generate signed URL
- [ ] Add `R2_CONFIG` constants to `src/common/constants.ts`
- [ ] Add `R2UploadResult` type to `src/common/types.ts`
- [ ] Extend `FileExportResult` type with `download_url`, `url_expires_at`, `storage_type`

**Tests (Claude Code - stdio):**
- [ ] Run `npm run build` - should compile without errors
- [ ] Run TypeScript check: `npx tsc --noEmit` - no type errors
- [ ] Test `isR2Enabled()` returns false without env vars
- [ ] Test `isR2Enabled()` returns true with mock env vars

**Tests (claude.ai - HTTP):**
- [ ] N/A - Infrastructure only, no user-facing changes yet

**Success Criteria:**
- R2 client compiles and exports all functions
- Type definitions are complete and documented
- Feature flag (R2_CONFIG.ENABLED) correctly detects env vars

---

### Stage 2: Buffer Export Capability
**Goal:** Enable Excel generation to memory buffer instead of filesystem
**Estimated effort:** Simple (1 hour)

**Tasks:**
- [ ] Add `createWorkbookBuffer(request): Buffer` to `src/common/services/file-export.ts`
- [ ] Add `exportToR2(buffer, filename)` helper that uploads and returns result
- [ ] Modify `exportAggregationToExcel()` to optionally use R2
- [ ] Modify `exportRecordsToExcel()` to optionally use R2
- [ ] Add `ExportOptions` interface with `forceLocal` flag
- [ ] Update `formatExportResponse()` to show download URL for R2 exports

**Tests (Claude Code - stdio):**
- [ ] Unit test: `createWorkbookBuffer()` returns valid Buffer
- [ ] Unit test: Buffer size matches expected for test data
- [ ] Run existing export tests pass (backward compatible)

**Tests (claude.ai - HTTP):**
- [ ] N/A - No user-facing changes yet

**Success Criteria:**
- Can create Excel as Buffer without writing to disk
- Existing local export still works unchanged
- formatExportResponse shows clickable URL for R2 exports

---

### Stage 3: Export Orchestrator
**Goal:** Centralize export decision logic and auto-trigger capability
**Estimated effort:** Medium (2 hours)

**Tasks:**
- [ ] Create `src/common/services/export-orchestrator.ts` with:
  - `estimateResultTokens(result)` - estimate tokens for any result type
  - `shouldAutoExport(result, userRequested?)` - decision logic
  - `executeExport(result, options?)` - route to local or R2
  - `formatExportResponse(result, isAutoTriggered?)` - unified formatting
- [ ] Add `AUTO_EXPORT_CONFIG` constants (threshold: 10,000 tokens)
- [ ] Export all functions for tool integration

**Tests (Claude Code - stdio):**
- [ ] Unit test: `estimateResultTokens()` returns ~300 for simple aggregation
- [ ] Unit test: `estimateResultTokens()` returns ~10,300 for 200 groups
- [ ] Unit test: `shouldAutoExport()` returns false below threshold
- [ ] Unit test: `shouldAutoExport()` returns true above threshold
- [ ] Unit test: `executeExport()` routes to local when R2 disabled
- [ ] Unit test: `executeExport()` routes to R2 when enabled

**Tests (claude.ai - HTTP):**
- [ ] N/A - No user-facing changes yet

**Success Criteria:**
- Token estimation accurate within 20%
- Auto-export triggers at 10,000+ tokens
- Correct routing based on R2_ENABLED flag

---

### Stage 4: Token Estimation Enhancements
**Goal:** Add token estimators for all 6 tool result types
**Estimated effort:** Simple (1 hour)

**Tasks:**
- [ ] Add to `src/exact/services/token-estimator.ts`:
  - `estimateSemanticSearchTokens(count)` - 300 + (count × 150)
  - `estimateGraphTraversalTokens(outgoing, incoming, depth)` - 400 + (out × 50) + (in × 30)
  - `estimateInspectRecordTokens(fieldCount)` - 200 + (fields × 10)
  - `estimateSystemStatusTokens(section, modelCount)` - 300 + (models × 20)
  - `estimateGenericTokens(jsonString)` - json.length / 4
- [ ] Export all new functions
- [ ] Add JSDoc documentation with examples

**Tests (Claude Code - stdio):**
- [ ] Unit test: Semantic search with 100 results → ~15,300 tokens
- [ ] Unit test: Graph traverse with 20 outgoing, 10 incoming → ~1,700 tokens
- [ ] Unit test: Inspect record with 50 fields → ~700 tokens
- [ ] Unit test: System status with 10 models → ~500 tokens

**Tests (claude.ai - HTTP):**
- [ ] N/A - No user-facing changes yet

**Success Criteria:**
- All 6 result types have dedicated estimators
- Formulas are empirically reasonable
- Export functions available for orchestrator

---

### Stage 5: Tool Integration - nexsus_search
**Goal:** Integrate orchestrator with nexsus_search (already has export_to_file)
**Estimated effort:** Simple (30 min)

**Tasks:**
- [ ] Import orchestrator functions in `src/exact/tools/nexsus-search.ts`
- [ ] Replace direct export calls with `executeExport()` call
- [ ] Add auto-export check using `shouldAutoExport()`
- [ ] Use `formatExportResponse()` for consistent output
- [ ] Test both aggregation and record modes

**Tests (Claude Code - stdio):**
- [ ] Test: Small aggregation (10 groups) returns inline result
- [ ] Test: Large aggregation (500 groups) triggers auto-export
- [ ] Test: `export_to_file: true` still works manually
- [ ] Test: `export_to_file: false` prevents auto-export

**Tests (claude.ai - HTTP):**
- [ ] Query with >200 groups → should see "Export Complete (Auto-Triggered)"
- [ ] Click download URL → Excel file downloads
- [ ] Verify Excel has Data + Reconciliation sheets
- [ ] Wait 1 hour → URL should expire (optional verification)

**Success Criteria:**
- Auto-export triggers for large results
- Manual export still works
- R2 URL is clickable and downloads valid Excel

---

### Stage 6: Tool Integration - semantic_search & find_similar
**Goal:** Add export capability to semantic search tools
**Estimated effort:** Medium (1.5 hours)

**Tasks:**
- [ ] Add `export_to_file` parameter to `SemanticSearchSchema` in `src/common/schemas/index.ts`
- [ ] Add `export_to_file` parameter to `FindSimilarSchema`
- [ ] Modify `semantic_search` handler in `src/semantic/tools/search-tool.ts`:
  - Add auto-export check after results computed
  - Convert results to exportable format
  - Call orchestrator for export
- [ ] Modify `find_similar` handler similarly
- [ ] Add `exportGenericToExcel()` function for array-of-objects export

**Tests (Claude Code - stdio):**
- [ ] Test: `semantic_search` with `export_to_file: true` creates Excel
- [ ] Test: `find_similar` with `export_to_file: true` creates Excel
- [ ] Test: Auto-export triggers when result count > threshold
- [ ] Test: Schema validation accepts new parameter

**Tests (claude.ai - HTTP):**
- [ ] `semantic_search` with `limit: 200` and `export_to_file: true` → download URL
- [ ] `find_similar` with `limit: 100` → should auto-export if >10K tokens
- [ ] Verify Excel contains similarity scores and payload fields
- [ ] Download and open in Excel - verify data integrity

**Success Criteria:**
- Both tools support `export_to_file` parameter
- Auto-export works based on token estimation
- Excel format includes relevant columns (score, name, etc.)

---

### Stage 7: Tool Integration - graph_traverse & inspect_record
**Goal:** Add export capability to navigation tools
**Estimated effort:** Medium (1.5 hours)

**Tasks:**
- [ ] Add `export_to_file` to `GraphTraverseSchema` in schemas
- [ ] Add `export_to_file` to `InspectRecordSchema` in schemas
- [ ] Modify `graph_traverse` handler in `src/common/tools/graph-tool.ts`:
  - Flatten traverse result to exportable rows (node type, field, target, etc.)
  - Add auto-export check
  - Call orchestrator
- [ ] Modify `inspect_record` handler in `src/common/tools/pipeline-tool.ts`:
  - Convert payload to exportable format
  - Add auto-export check
  - Call orchestrator

**Tests (Claude Code - stdio):**
- [ ] Test: `graph_traverse` with `export_to_file: true` exports nodes/edges
- [ ] Test: `inspect_record` with `export_to_file: true` exports payload
- [ ] Test: Deep traversal (depth: 3) auto-triggers export
- [ ] Test: Record with many fields auto-triggers export

**Tests (claude.ai - HTTP):**
- [ ] `graph_traverse` with `direction: both` and `depth: 2` → download if large
- [ ] `inspect_record` with `with_raw: true` → download URL
- [ ] Verify graph Excel has columns: type, model, record_id, field, target
- [ ] Verify inspect Excel has columns: field_name, field_value, field_type

**Success Criteria:**
- Both tools support export parameter
- Graph data flattened correctly for Excel
- Payload fields exported with proper columns

---

### Stage 8: Tool Integration - system_status
**Goal:** Add export capability to system_status (pipeline data)
**Estimated effort:** Simple (30 min)

**Tasks:**
- [ ] Add `export_to_file` to `SystemStatusSchema` in schemas
- [ ] Modify `system_status` handler in `src/exact/tools/data-tool.ts`:
  - Convert pipeline/metrics data to exportable format
  - Add auto-export check for large status (many synced models)
  - Call orchestrator

**Tests (Claude Code - stdio):**
- [ ] Test: `system_status` with `section: pipeline` and `export_to_file: true`
- [ ] Test: Status with 20+ synced models auto-triggers export
- [ ] Test: Small status (3 models) returns inline

**Tests (claude.ai - HTTP):**
- [ ] `system_status` with `section: all` and `export_to_file: true`
- [ ] Verify Excel has sync history, model counts, error rates

**Success Criteria:**
- system_status supports export
- Pipeline data formatted for Excel analysis
- Useful for audit/monitoring reports

---

### Stage 9: Railway Deployment & Testing
**Goal:** Configure R2 in production and verify end-to-end
**Estimated effort:** Simple (1 hour)

**Tasks:**
- [ ] Create Cloudflare R2 bucket: `nexsus-exports`
- [ ] Generate R2 API token with read/write permissions
- [ ] Add environment variables to Railway:
  - `R2_ACCOUNT_ID`
  - `R2_ACCESS_KEY_ID`
  - `R2_SECRET_ACCESS_KEY`
  - `R2_BUCKET_NAME=nexsus-exports`
- [ ] Deploy to Railway
- [ ] Test all 6 tools from claude.ai

**Tests (Claude Code - stdio):**
- [ ] Local dev still works without R2 vars (local export)
- [ ] `npm run build` succeeds
- [ ] `npm run start` starts without errors

**Tests (claude.ai - HTTP):**
- [ ] `nexsus_search` with large aggregation → R2 download URL
- [ ] `semantic_search` with `export_to_file: true` → R2 download URL
- [ ] `find_similar` with large result → auto-export to R2
- [ ] `graph_traverse` with export → R2 download URL
- [ ] `inspect_record` with export → R2 download URL
- [ ] `system_status` with export → R2 download URL
- [ ] Verify all URLs work and download valid Excel files
- [ ] Verify URLs expire after 1 hour

**Success Criteria:**
- All 6 tools export to R2 in production
- Signed URLs work for 1 hour
- Local development unaffected (uses filesystem)
- No breaking changes to existing behavior

---

## Dependencies

- Cloudflare account with R2 enabled
- Railway deployment with environment variable support
- AWS SDK packages: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`
- Existing token-estimator.ts infrastructure
- Existing file-export.ts infrastructure

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| R2 credentials exposed | Use Railway encrypted env vars, never commit to git |
| Large files fail upload | Add size limit (50MB), compress if needed |
| URL expiry confuses users | Clear warning in response: "Link expires in 1 hour" |
| Token estimation inaccurate | Conservative estimates, test with real data |
| Breaking existing export | Feature flag `AUTO_EXPORT_ENABLED`, backward compatible |
| R2 costs unexpectedly high | Monitor usage, set bucket lifecycle rules for auto-cleanup |

## Notes

- **Cost**: R2 free tier includes 10GB storage, unlimited egress - likely stays free
- **Security**: Signed URLs are cryptographically secure, expire in 1 hour
- **Backward Compatibility**: Local export remains default when R2 not configured
- **Sheet Format**: Keeping current Data + Reconciliation format per user request
- **Token Threshold**: 10,000 tokens = ~200 groups or ~100 records with full payloads

---

## Appendix: Cloudflare R2 Setup Guide

### Step 1: Create Cloudflare Account (if needed)

1. Go to https://dash.cloudflare.com/
2. Sign up for free or log in
3. Note your **Account ID** from the URL or sidebar

### Step 2: Enable R2 Storage

1. In Cloudflare Dashboard, click **R2** in the left sidebar
2. Click **Create bucket**
3. Name it: `nexsus-exports`
4. Location: Choose closest to your users (e.g., `APAC` for Australia)
5. Click **Create bucket**

### Step 3: Generate R2 API Token

1. In R2 section, click **Manage R2 API Tokens**
2. Click **Create API token**
3. Configure:
   - **Token name**: `nexsus-mcp-export`
   - **Permissions**: `Object Read & Write`
   - **Specify bucket(s)**: Select `nexsus-exports`
   - **TTL**: Optional (recommend leaving unlimited for production)
4. Click **Create API Token**
5. **IMPORTANT**: Copy these values immediately (shown only once):
   - **Access Key ID**: `xxxxxxxxxxxxxxxx`
   - **Secret Access Key**: `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

### Step 4: Add Environment Variables to Railway

In your Railway project settings, add these variables:

```bash
# Required - all 4 must be set to enable R2
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_access_key_id
R2_SECRET_ACCESS_KEY=your_secret_access_key
R2_BUCKET_NAME=nexsus-exports

# Optional - defaults shown
R2_URL_EXPIRY=3600          # 1 hour (in seconds)
AUTO_EXPORT_ENABLED=true    # Enable auto-export
AUTO_EXPORT_THRESHOLD=10000 # Token threshold
```

### Step 5: Verify Setup

After deploying, use the `system_status` MCP tool. You should see:

```
## R2 Cloud Storage
────────────────────────────────
[OK] R2 Status: ENABLED
    Bucket: nexsus-exports
    URL Expiry: 3600s (60 min)
    Key Prefix: exports/
```

### Step 6: Test Auto-Export

Run a query that exceeds the token threshold:

```json
{
  "model_name": "account.move.line",
  "filters": [{"field": "date", "op": "gte", "value": "2024-01-01"}],
  "aggregations": [{"field": "debit", "op": "sum", "alias": "total"}],
  "group_by": ["partner_id_id"]
}
```

If results exceed 10K tokens, you'll get a download URL instead of inline data.

### Troubleshooting

| Issue | Solution |
|-------|----------|
| R2 Status shows DISABLED | Verify all 4 env vars are set correctly |
| Upload fails | Check API token has Object Read & Write permission |
| URL doesn't work | Ensure bucket name matches exactly |
| URL expires too fast | Increase `R2_URL_EXPIRY` value |

### Cost Considerations

- **R2 Free Tier**: 10GB storage + 10M Class A ops + 1M Class B ops + unlimited egress
- **Excel files**: ~50KB-500KB each (cleanup old files if storage fills up)
- **Recommendation**: Set bucket lifecycle policy to delete files after 7 days

### Bucket Lifecycle Policy (Optional)

To auto-delete old exports:

1. In R2 bucket settings, go to **Lifecycle**
2. Add rule:
   - **Prefix filter**: `exports/`
   - **Action**: Delete
   - **After**: 7 days
