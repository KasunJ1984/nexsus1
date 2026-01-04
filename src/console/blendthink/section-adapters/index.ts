/**
 * Section Adapters - Index
 *
 * Exports all section adapters and provides a factory function
 * to get the appropriate adapter for a given section.
 */

import type { BlendSection, SectionAdapter, AdapterContext } from '../../../common/types.js';
import { SemanticAdapter } from './semantic-adapter.js';
import { ExactAdapter } from './exact-adapter.js';
import { GraphAdapter } from './graph-adapter.js';
import { KnowledgeAdapter } from '../../../knowledge/adapter/index.js';

// =============================================================================
// EXPORTS
// =============================================================================

export * from './types.js';
export { SemanticAdapter } from './semantic-adapter.js';
export { ExactAdapter } from './exact-adapter.js';
export { GraphAdapter } from './graph-adapter.js';
export { KnowledgeAdapter } from '../../../knowledge/adapter/index.js';

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

/**
 * Cache of adapter instances (singleton per section)
 */
const adapterCache: Map<BlendSection, SectionAdapter> = new Map();

/**
 * Get adapter for a given section
 *
 * @param section - The blend section to get adapter for
 * @param context - Optional adapter context to customize behavior
 * @returns The appropriate section adapter
 */
export function getAdapter(
  section: BlendSection,
  context?: Partial<AdapterContext>
): SectionAdapter {
  // Check cache first (only if no custom context)
  if (!context && adapterCache.has(section)) {
    return adapterCache.get(section)!;
  }

  let adapter: SectionAdapter;

  switch (section) {
    case 'semantic':
      adapter = new SemanticAdapter(context);
      break;

    case 'exact':
      adapter = new ExactAdapter(context);
      break;

    case 'common':
      // Graph traversal is handled by common section
      adapter = new GraphAdapter(context);
      break;

    case 'knowledge':
      adapter = new KnowledgeAdapter(context);
      break;

    default:
      throw new Error(`No adapter available for section: ${section}`);
  }

  // Cache if no custom context
  if (!context) {
    adapterCache.set(section, adapter);
  }

  return adapter;
}

/**
 * Clear the adapter cache
 * Useful for testing or when context changes
 */
export function clearAdapterCache(): void {
  adapterCache.clear();
}

/**
 * Get all available section adapters
 */
export function getAvailableAdapters(): BlendSection[] {
  return ['semantic', 'exact', 'common', 'knowledge'];
}
