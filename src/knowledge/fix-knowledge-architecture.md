# Fix knowledge/ Architecture Violations

**Severity:** HIGH (1 violation)
**Date Identified:** 2026-01-02
**Source:** `/nerve-check` diagnostic

---

## Problem Summary

The `knowledge/` section imports types from `console/`, which violates the dependency hierarchy. Console is the "top of the tree" - it should import FROM other sections, but other sections should NEVER import from console.

| Location | Imports From | Violation Type |
|----------|--------------|----------------|
| `src/knowledge/adapter/knowledge-adapter.ts:18-19` | `console/blendthink/section-adapters/types.js` | HIGH |

---

## Root Cause

The `SectionAdapter` interface and `AdapterContext` type were defined in console/blendthink/ because that's where blendthink was implemented. However, these types are **shared contracts** that multiple sections need to implement - they should live in common/.

**Current import in knowledge-adapter.ts:**
```typescript
import type {
  SectionAdapter,
  SectionResult,
  AdapterContext,
} from '../../console/blendthink/section-adapters/types.js';
import { DEFAULT_ADAPTER_CONTEXT } from '../../console/blendthink/section-adapters/types.js';
```

---

## Step-by-Step Fix

### Fix 1: Move SectionAdapter Types to common/

**Current location:**
```
src/console/blendthink/section-adapters/types.ts
```

**Option A (Recommended):** Move adapter types to `src/common/types.ts`

The `SectionAdapter`, `SectionResult`, `AdapterContext` interfaces are shared contracts - any section can implement an adapter.

**Option B:** Create `src/common/types/adapter-types.ts`

If you prefer to keep adapter types separate from main types file.

---

### Recommended Approach - Option A

**Step 1:** Add types to `src/common/types.ts`

The following types need to be moved from `src/console/blendthink/section-adapters/types.ts`:

```typescript
// Section adapter types (for blendthink integration)
export interface AdapterContext {
  maxTokens: number;
  timeoutMs: number;
  includeMetadata: boolean;
}

export const DEFAULT_ADAPTER_CONTEXT: AdapterContext = {
  maxTokens: 10000,
  timeoutMs: 30000,
  includeMetadata: true,
};

export interface SectionResult {
  success: boolean;
  data: unknown;
  metadata?: {
    source: string;
    confidence: number;
    tokensUsed: number;
    durationMs: number;
  };
  error?: string;
}

export interface SectionAdapter {
  name: string;
  execute(step: RouteStep, analysis: QuestionAnalysis, context?: AdapterContext): Promise<SectionResult>;
}
```

**Step 2:** Update imports in all files that use these types

**Files to update:**

1. `src/knowledge/adapter/knowledge-adapter.ts`:
```typescript
// Change:
import type {
  SectionAdapter,
  SectionResult,
  AdapterContext,
} from '../../console/blendthink/section-adapters/types.js';
import { DEFAULT_ADAPTER_CONTEXT } from '../../console/blendthink/section-adapters/types.js';

// To:
import type {
  SectionAdapter,
  SectionResult,
  AdapterContext,
} from '../../common/types.js';
import { DEFAULT_ADAPTER_CONTEXT } from '../../common/types.js';
```

2. `src/console/blendthink/section-adapters/types.ts`:
```typescript
// Change to re-export from common (for backward compatibility):
export type { SectionAdapter, SectionResult, AdapterContext } from '../../../common/types.js';
export { DEFAULT_ADAPTER_CONTEXT } from '../../../common/types.js';

// OR delete this file entirely and update all console imports
```

3. `src/console/blendthink/section-adapters/exact-adapter.ts`:
```typescript
// Change:
import type { SectionAdapter, SectionResult, AdapterContext } from './types.js';
import { DEFAULT_ADAPTER_CONTEXT } from './types.js';

// To:
import type { SectionAdapter, SectionResult, AdapterContext } from '../../../common/types.js';
import { DEFAULT_ADAPTER_CONTEXT } from '../../../common/types.js';
```

4. `src/console/blendthink/section-adapters/semantic-adapter.ts`:
```typescript
// Same pattern as exact-adapter.ts
```

5. `src/console/blendthink/section-adapters/graph-adapter.ts`:
```typescript
// Same pattern as exact-adapter.ts
```

6. `src/console/blendthink/section-adapters/index.ts`:
```typescript
// Update any re-exports
```

7. `src/console/blendthink/engine.ts`:
```typescript
// Check if it imports from types.ts and update if needed
```

---

## Verification

### Section-Specific Checks

After completing fixes, run this grep command to verify no violations remain:

```bash
# Check knowledge/ does NOT import from console/
grep -rn "from.*\.\.\/console\|from.*\.\.\/\.\.\/console\|from.*src\/console" src/knowledge/

# Expected result: No matches found
```

### Additional Check - Ensure types are accessible

```bash
# Verify common/types.ts exports the adapter types
grep -n "SectionAdapter\|SectionResult\|AdapterContext" src/common/types.ts

# Expected result: Should show the type definitions
```

### Build Verification

```bash
# Ensure TypeScript compiles without errors
npm run build

# Run blendthink tests to ensure adapters still work
npm run test:blendthink
```

### Final System Check

After completing fixes in ALL sections (common/ and knowledge/), run:

```
/nerve-check
```

**Expected result:** Phase 2 (Communication Pathways) should show GREEN with no HIGH violations in knowledge/.

---

## Notes

- This is a simpler fix than common/ - just moving type definitions
- Consider whether `src/console/blendthink/section-adapters/types.ts` should be deleted or kept as a re-export for backward compatibility
- Update `src/knowledge/CLAUDE.md` if needed after the fix
- The `RouteStep` and `QuestionAnalysis` types referenced by `SectionAdapter` may also need to be in common/types.ts - check during implementation
