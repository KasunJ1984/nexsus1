# Fix common/ Architecture Violations

**Severity:** CRITICAL (3 violations)
**Date Identified:** 2026-01-02
**Source:** `/nerve-check` diagnostic

---

## Problem Summary

The `common/` section (the "spinal cord" of the architecture) is importing from other sections, which violates the foundational rule that **common/ must only import external packages**.

| Location | Imports From | Violation Type |
|----------|--------------|----------------|
| `src/common/sync/index.ts:25` | `knowledge/` | CRITICAL |
| `src/common/tools/url-builder-tool.ts:16-17` | `exact/` | CRITICAL |
| `src/common/tools/graph-tool.ts:32` | `semantic/` | CRITICAL |

---

## Root Cause

During the 5-section architecture migration (commits a774130 → 10f833e), some files were placed in `common/` that either:
1. **Belong in console/** - The CLI sync commands are orchestration, not shared infrastructure
2. **Need shared dependencies extracted** - Some services in exact/ and semantic/ are actually shared infrastructure that should live in common/

---

## Step-by-Step Fix

### Fix 1: Move CLI Sync to console/

**Problem:** `src/common/sync/index.ts` imports from `knowledge/`

**Current location:**
```
src/common/sync/
├── index.ts              <- imports from ../../knowledge/
└── commands/
    ├── analyze-patterns.ts
    ├── cleanup.ts
    ├── fix-orphans.ts
    ├── status.ts
    ├── sync-model.ts
    ├── sync-schema.ts
    └── validate-fk.ts
```

**Move to:**
```
src/console/sync/
├── index.ts
└── commands/
    └── (all command files)
```

**Files to update after move:**
- `package.json` - Update the sync script path:
  ```json
  "sync": "node dist/console/sync/index.js"
  ```
- `src/console/sync/index.ts` - Update import path:
  ```
  Change: import { syncKnowledgeCommand } from '../../knowledge/dynamic/loaders/index.js';
  To:     import { syncKnowledgeCommand } from '../../knowledge/dynamic/loaders/index.js';
  ```
  (Path stays same since we're moving within src/)

**Commands to execute:**
```bash
# Move the sync directory
git mv src/common/sync src/console/sync

# Update package.json sync script path
# Edit: "sync": "node dist/console/sync/index.js"
```

---

### Fix 2: Move scroll-engine.ts and filter-builder.ts to common/

**Problem:** `src/common/tools/url-builder-tool.ts` imports from `exact/`

**Current imports in url-builder-tool.ts:**
```typescript
import { scrollRecords } from '../../exact/services/scroll-engine.js';
import { buildQdrantFilter } from '../../exact/services/filter-builder.js';
```

**These services are shared infrastructure** - they're used by both exact/ tools AND common/ tools, so they belong in common/.

**Move files:**
```
src/exact/services/scroll-engine.ts    -> src/common/services/scroll-engine.ts
src/exact/services/filter-builder.ts   -> src/common/services/filter-builder.ts
```

**Files that import these (need path updates):**

For `scroll-engine.ts`:
- `src/exact/tools/nexsus-search.ts`
- `src/common/tools/url-builder-tool.ts`

For `filter-builder.ts`:
- `src/exact/tools/nexsus-search.ts`
- `src/exact/services/dot-notation-resolver.ts`
- `src/common/tools/url-builder-tool.ts`

**Commands to execute:**
```bash
# Move the files
git mv src/exact/services/scroll-engine.ts src/common/services/scroll-engine.ts
git mv src/exact/services/filter-builder.ts src/common/services/filter-builder.ts
```

**Import updates needed:**

In `src/exact/tools/nexsus-search.ts`:
```typescript
// Change:
import { buildQdrantFilter, ... } from '../services/filter-builder.js';
import { scrollRecords } from '../services/scroll-engine.js';

// To:
import { buildQdrantFilter, ... } from '../../common/services/filter-builder.js';
import { scrollRecords } from '../../common/services/scroll-engine.js';
```

In `src/exact/services/dot-notation-resolver.ts`:
```typescript
// Change:
import { buildQdrantFilter } from './filter-builder.js';

// To:
import { buildQdrantFilter } from '../../common/services/filter-builder.js';
```

In `src/common/tools/url-builder-tool.ts`:
```typescript
// Change:
import { scrollRecords } from '../../exact/services/scroll-engine.js';
import { buildQdrantFilter } from '../../exact/services/filter-builder.js';

// To:
import { scrollRecords } from '../services/scroll-engine.js';
import { buildQdrantFilter } from '../services/filter-builder.js';
```

---

### Fix 3: Move getGraphContext to common/

**Problem:** `src/common/tools/graph-tool.ts` imports from `semantic/`

**Current import:**
```typescript
import { getGraphContext } from '../../semantic/services/graph-search-engine.js';
```

**Option A (Recommended):** Move `getGraphContext` function to `src/common/services/knowledge-graph.ts`

This function provides graph context (FK relationships) which is shared infrastructure, not semantic-specific.

**Option B:** Move `graph-tool.ts` to semantic/ section

If graph traversal is considered a semantic operation, the tool could live there instead.

**Recommended approach - Option A:**

1. Extract `getGraphContext` from `src/semantic/services/graph-search-engine.ts`
2. Add it to `src/common/services/knowledge-graph.ts`
3. Update imports in both files

**Files that import getGraphContext:**
- `src/common/tools/graph-tool.ts`
- `src/exact/tools/nexsus-search.ts`
- `src/semantic/tools/search-tool.ts`

**Import updates needed after move:**

In `src/common/tools/graph-tool.ts`:
```typescript
// Change:
import { getGraphContext } from '../../semantic/services/graph-search-engine.js';

// To:
import { getGraphContext } from '../services/knowledge-graph.js';
```

In `src/exact/tools/nexsus-search.ts`:
```typescript
// Change:
import { getGraphContext } from '../../semantic/services/graph-search-engine.js';

// To:
import { getGraphContext } from '../../common/services/knowledge-graph.js';
```

In `src/semantic/tools/search-tool.ts`:
```typescript
// Change:
import { getGraphContext, ... } from '../services/graph-search-engine.js';

// To:
import { getGraphContext } from '../../common/services/knowledge-graph.js';
import { countConnections, computeGraphBoost, ... } from '../services/graph-search-engine.js';
```

---

## Verification

### Section-Specific Checks

After completing all fixes, run these grep commands to verify no violations remain:

```bash
# Check common/ does NOT import from other sections
grep -rn "from.*\.\.\/semantic\|from.*\.\.\/exact\|from.*\.\.\/console\|from.*\.\.\/knowledge" src/common/

# Expected result: No matches found

# Check common/ does NOT import using src/ paths to other sections
grep -rn "from.*src\/semantic\|from.*src\/exact\|from.*src\/console\|from.*src\/knowledge" src/common/

# Expected result: No matches found
```

### Build Verification

```bash
# Ensure TypeScript compiles without errors
npm run build

# Ensure CLI still works
npm run sync -- status
```

### Final System Check

After completing fixes in ALL sections (common/ and knowledge/), run:

```
/nerve-check
```

**Expected result:** Phase 2 (Communication Pathways) should show GREEN with no CRITICAL violations.

---

## Notes

- The sync/ directory move is the largest change - test thoroughly
- filter-builder.ts and scroll-engine.ts are heavily used - update all imports carefully
- Consider updating `src/common/CLAUDE.md` file ownership manifest after moves
