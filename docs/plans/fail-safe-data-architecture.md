# Fail-Safe Data Architecture: Fix Silent Data Loss

## Overview
Fix 19 silent data loss issues discovered in the Nexsus MCP server. The root cause is that `passesAppFilters()` cannot distinguish between "field is null in Odoo" vs "field not requested in projection", causing 20% of records to be silently dropped when using the `fields` parameter.

**Business Impact:** Commercial-grade solution requires 100% data integrity. Query results MUST match Odoo counts exactly.

---

## Stages

### Stage 1: Core passesAppFilters Fix
**Goal:** Fix the root cause of 778/981 bug - throw error if filter field not in projection
**Estimated effort:** Medium

**Files:**
- `src/services/scroll-engine.ts` (lines 297-347)
- `src/services/aggregation-engine.ts` (lines 461-495)

**Tasks:**
- [ ] Create new `AppFilterResult` interface with `passed`, `filtered`, `reason` fields
- [ ] Add `requestedFields: Set<string> | 'all'` parameter to `passesAppFilters()`
- [ ] Throw error if filter field not in requestedFields (fail-fast behavior)
- [ ] Return filtering reason when field is null/undefined in Odoo
- [ ] Update `scrollRecords()` to build requestedFields set from options.fields
- [ ] Update `scrollRecords()` to auto-include filter fields in requestedFields
- [ ] Add `filteredCount` and `filteringDetails` to ScrollResult

**Tests (Claude Code - stdio):**
- [ ] Run query: `nexsus_search` with `fields: ["date"]` and filter on `parent_state` → should throw error
- [ ] Run query: `nexsus_search` with `fields: ["date", "parent_state"]` and filter on null `parent_state` → should return with `filteringDetails`
- [ ] Verify Jan 2025 Product Revenue query returns 981 records (not 778)

**Tests (claude.ai - HTTP):**
- [ ] Query account.move.line with fields parameter + app filter → verify error message
- [ ] Query January 2025 Product Revenue → verify total matches Odoo ($1,388,344.08)
- [ ] Check response includes `filteringDetails` with count and reasons

**Success Criteria:**
- Error thrown when filter field missing from projection (fail-fast)
- Query with proper fields returns 100% of records
- Filtering metadata visible in response

---

### Stage 2: Aggregation Truncation Transparency
**Goal:** Surface clear warning when 100K safety limit truncates results
**Estimated effort:** Simple

**Files:**
- `src/services/aggregation-engine.ts` (lines 176-179)
- `src/types.ts`

**Tasks:**
- [ ] Add `TruncationDetails` interface to types.ts
- [ ] When limit reached, call Qdrant count API for estimated total
- [ ] Add `truncation_details` to AggregationResult with warning message
- [ ] Surface truncation warning prominently in formatted output

**Tests (Claude Code - stdio):**
- [ ] Query account.move.line without date filter (>100K records) → verify truncation warning appears
- [ ] Verify `estimated_total` field populated from Qdrant count

**Tests (claude.ai - HTTP):**
- [ ] Run large aggregation query → verify warning at TOP of response
- [ ] Verify warning includes actionable advice ("Use date filters to process in batches")

**Success Criteria:**
- Truncation warning visible in response (not just console.error)
- Estimated total count provided to user
- Clear guidance on how to handle large datasets

---

### Stage 3: Metadata Timestamp Safety
**Goal:** Only update sync metadata timestamp when sync fully succeeds
**Estimated effort:** Simple

**Files:**
- `src/services/pipeline-data-sync.ts` (lines 728-734)

**Tasks:**
- [ ] Add `sync_status: 'complete' | 'partial'` to SyncMetadata interface
- [ ] Only update `last_sync_timestamp` if `recordsFailed === 0`
- [ ] Keep old timestamp on partial failure (triggers re-sync)
- [ ] Add `failed_records` count and `last_failure` timestamp for partial syncs
- [ ] Log clear WARNING when metadata NOT updated due to failures

**Tests (Claude Code - stdio):**
- [ ] Run `npm run sync -- sync model <test_model>` with network failure mid-sync
- [ ] Verify `pipeline_sync_metadata.json` timestamp NOT updated
- [ ] Verify `sync_status: 'partial'` in metadata

**Tests (claude.ai - HTTP):**
- [ ] Check `system_status` after partial sync → verify warning about partial sync
- [ ] Verify next sync attempt re-processes failed period

**Success Criteria:**
- Partial sync does NOT update timestamp (re-sync triggered)
- Clear visibility of sync failures in metadata
- No silent data gaps between sync runs

---

### Stage 4: DLQ Archive Instead of Delete
**Goal:** Archive overflow DLQ records instead of deleting them
**Estimated effort:** Simple

**Files:**
- `src/services/dlq.ts` (lines 80-85)

**Tasks:**
- [ ] Create `dlq_archive.json` file path constant
- [ ] When DLQ exceeds 1000, move overflow to archive (not delete)
- [ ] Load existing archive before appending
- [ ] Log warning about archive size for periodic review
- [ ] Add `dlq_archive_count` to dlq_status response

**Tests (Claude Code - stdio):**
- [ ] Manually add 1005 records to DLQ → verify 5 archived to `dlq_archive.json`
- [ ] Verify archived records still accessible for debugging

**Tests (claude.ai - HTTP):**
- [ ] Run `dlq_status` → verify shows archive count if exists
- [ ] Verify no records permanently deleted

**Success Criteria:**
- No DLQ records ever deleted (archived instead)
- Archive accessible for debugging failed records
- Warning when archive grows large

---

### Stage 5: FK Resolution Transparency
**Goal:** Surface missing FK targets and dropped-by-limit counts in query response
**Estimated effort:** Medium

**Files:**
- `src/services/nexsus-link.ts` (lines 132-136, 292-295)
- `src/tools/nexsus-search.ts`

**Tasks:**
- [ ] Track `droppedByLimit` counts per field in `collectFkQdrantIds()`
- [ ] Add `droppedByLimit` to LinkResolutionResult stats
- [ ] Surface `missingTargets` warning in nexsus_search formatted output
- [ ] Include sample UUIDs for debugging orphan FKs
- [ ] Add actionable advice: "Run validate-fk --auto-sync"

**Tests (Claude Code - stdio):**
- [ ] Query with `link: ["partner_id"]` where some partners not in Qdrant
- [ ] Verify warning shows count of missing targets
- [ ] Query with >100 unique FK values → verify `droppedByLimit` reported

**Tests (claude.ai - HTTP):**
- [ ] Run query with Nexsus Link → verify FK resolution stats in response
- [ ] Verify missing target warning includes sample UUIDs

**Success Criteria:**
- Missing FK targets reported with count
- Dropped-by-limit count visible per field
- Actionable guidance for resolving orphan FKs

---

### Stage 6: Sync Robustness (Failure Thresholds)
**Goal:** Abort sync after consecutive failures threshold exceeded
**Estimated effort:** Medium

**Files:**
- `src/services/pipeline-data-sync.ts` (lines 682-687)
- `src/sync/commands/sync.ts`

**Tasks:**
- [ ] Add `max_consecutive_failures` option to PipelineSyncOptions (default: 3)
- [ ] Track consecutive failure count in sync loop
- [ ] Abort sync when threshold exceeded with clear error
- [ ] Reset consecutive count on successful batch
- [ ] Add CLI flag: `--max-failures <n>`
- [ ] Add `restricted_fields` array to PipelineSyncResult

**Tests (Claude Code - stdio):**
- [ ] Run sync with simulated failures → verify aborts after 3 consecutive
- [ ] Run `npm run sync -- sync model <model> --max-failures 5` → verify respects flag
- [ ] Verify restricted fields reported in sync result

**Tests (claude.ai - HTTP):**
- [ ] Check sync result includes `restricted_fields` array
- [ ] Verify failure threshold prevents infinite retry loops

**Success Criteria:**
- Sync aborts after N consecutive failures (configurable)
- Restricted fields visible in sync result
- No infinite retry loops on persistent failures

---

### Stage 7: Filtering Metadata & Enrichment Limits
**Goal:** Surface app filter counts and enrichment limitations in response
**Estimated effort:** Simple

**Files:**
- `src/services/scroll-engine.ts` (lines 152-154)
- `src/services/data-grid.ts` (lines 95-98)

**Tasks:**
- [ ] Track app filter rejection count in scroll loop
- [ ] Add `filteringDetails` to all ScrollResult returns
- [ ] Add `enrichment_limited` flag to DataGrid result
- [ ] Surface enrichment limit warning in formatted output
- [ ] Allow `max_enriched` override (capped at 50)

**Tests (Claude Code - stdio):**
- [ ] Query with date filter that excludes some records → verify `filtered_count` in response
- [ ] Query with enrichment on 50 records → verify `enrichment_limited` warning

**Tests (claude.ai - HTTP):**
- [ ] Run query with app filters → verify filtering metadata visible
- [ ] Run query with `include_graph_context` on large result → verify enrichment limit noted

**Success Criteria:**
- Filtering count visible (not just records returned)
- Enrichment limitation clearly communicated
- User knows exactly what was filtered/limited and why

---

### Stage 8: Minor Fixes (Display, Grouping, Export)
**Goal:** Fix remaining low-priority display and logging issues
**Estimated effort:** Simple

**Files:**
- `src/tools/nexsus-search.ts` (line 1291)
- `src/services/aggregation-engine.ts` (lines 385-390)
- `src/services/file-export.ts` (lines 111-112)
- `src/tools/search-tool.ts` (lines 354-402)
- `src/services/scroll-engine.ts` (lines 164-170)

**Tasks:**
- [ ] Add "Showing X of Y records" note when display truncated
- [ ] Use `__NULL__` marker for null group keys (not string "null")
- [ ] Log skipped empty sheets in file export
- [ ] Add graph boost warning for large result sets
- [ ] Add `hasMore_uncertain` flag when app filters active

**Tests (Claude Code - stdio):**
- [ ] Query returning 100 records → verify "Showing 10 of 100" message
- [ ] Group by nullable field → verify null group clearly marked
- [ ] Export with empty group → verify log shows skipped sheet

**Tests (claude.ai - HTTP):**
- [ ] Run query with many records → verify truncation note visible
- [ ] Run aggregation with null values → verify null group labeled clearly

**Success Criteria:**
- Display truncation noted (not silent)
- Null handling unambiguous in groups
- All skipped/filtered items logged

---

## Dependencies
- Existing Qdrant collection with synced data
- Access to Odoo for reconciliation testing
- Jest test framework for unit tests

## Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| Breaking existing queries | Throw error only for invalid configs, not valid queries |
| Performance impact of count API | Use `exact: false` for fast approximate counts |
| Large archive files | Add periodic archive rotation/cleanup guidance |
| Complex refactor of passesAppFilters | Stage 1 is self-contained, can rollback independently |

## Notes
- The 778/981 bug was discovered when exporting January 2025 Product Revenue
- Odoo balance of $1,388,344.08 confirmed as correct (Credit - Debit)
- All fixes follow fail-safe principle: surface warnings, never silent drops
- Unit tests should be added to `src/__tests__/data-integrity.test.ts`

## Verification After All Stages
Run this reconciliation test:
```
Query: account.move.line, account_id_id=511, date 2025-01-01 to 2025-01-31, parent_state=posted
Expected: Net Revenue = $1,388,344.08 (matches Odoo)
Records: 981 lines
```
