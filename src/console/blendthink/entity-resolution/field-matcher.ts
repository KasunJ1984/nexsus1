/**
 * Field Matcher
 *
 * Resolves entity names to field filters using schema search and data lookup.
 *
 * Process:
 * 1. Search schema to find fields that might contain the entity value
 * 2. Search data to find records matching the entity (for FK filters)
 * 3. Build filter conditions from matched fields and values
 *
 * Examples:
 * - "staff welfare" → account_id IN [account records with welfare in name]
 * - "Hansen" → partner_id IN [res.partner IDs matching Hansen]
 * - "Victoria" → state = "Victoria" or state_id IN [...]
 */

import { embed } from '../../../common/services/embedding-service.js';
import { searchByPointType, searchByPayloadFilter } from '../../../common/services/vector-client.js';
import type { FieldResolution } from './types.js';
import type { Domain } from './model-finder.js';

// =============================================================================
// FIELD MATCHING CONFIGURATION
// =============================================================================

/**
 * Common FK field patterns for each domain
 * These help identify which fields are likely FK lookups
 */
const FK_FIELD_PATTERNS: Record<Domain, string[]> = {
  financial: ['account_id', 'partner_id', 'journal_id', 'company_id', 'currency_id'],
  crm: ['partner_id', 'user_id', 'stage_id', 'team_id', 'country_id', 'state_id'],
  hr: ['employee_id', 'department_id', 'job_id', 'company_id', 'manager_id'],
  inventory: ['product_id', 'location_id', 'warehouse_id', 'lot_id', 'category_id'],
  general: ['partner_id', 'user_id', 'company_id', 'country_id', 'state_id'],
};

/**
 * Models to search for each FK field type
 */
const FK_TARGET_MODELS: Record<string, string> = {
  account_id: 'account.account',
  partner_id: 'res.partner',
  journal_id: 'account.journal',
  company_id: 'res.company',
  currency_id: 'res.currency',
  user_id: 'res.users',
  stage_id: 'crm.stage',
  team_id: 'crm.team',
  country_id: 'res.country',
  state_id: 'res.country.state',
  employee_id: 'hr.employee',
  department_id: 'hr.department',
  job_id: 'hr.job',
  manager_id: 'hr.employee',
  product_id: 'product.product',
  location_id: 'stock.location',
  warehouse_id: 'stock.warehouse',
  lot_id: 'stock.lot',
  category_id: 'product.category',
};

/**
 * CRM Stage keyword mappings
 *
 * Maps natural language stage keywords to potential stage names in Odoo.
 * Multiple variations are provided because stage names vary by installation.
 */
const CRM_STAGE_KEYWORDS: Record<string, string[]> = {
  // Won deals - various stage names used in Odoo
  won: ['Won', 'Signed', 'Signed OC', 'In Production', 'Closed Won', 'Contract', 'Contracted'],
  // Lost deals
  lost: ['Lost', 'Closed Lost', 'Cancelled', 'Dead'],
  // New leads
  new: ['New', 'Lead', 'Incoming', 'Unassigned'],
  // Qualified leads
  qualified: ['Qualified', 'Opportunity', 'Validated'],
  // Proposal stage
  proposal: ['Proposition', 'Proposal', 'Quote', 'Quotation', 'Negotiation'],
};

// =============================================================================
// STAGE KEYWORD RESOLUTION
// =============================================================================

/**
 * Check if entity is a CRM stage keyword and resolve it
 *
 * @returns FieldResolution if entity matches a stage keyword, null otherwise
 */
async function resolveStageKeyword(
  entity: string,
  domain: Domain
): Promise<FieldResolution | null> {
  // Only for CRM domain
  if (domain !== 'crm') {
    return null;
  }

  const lowerEntity = entity.toLowerCase();

  // Check if entity matches any stage keyword
  for (const [keyword, stageNames] of Object.entries(CRM_STAGE_KEYWORDS)) {
    if (lowerEntity === keyword || lowerEntity.includes(keyword)) {
      console.error(`[FieldMatcher] Matched stage keyword: "${entity}" → ${keyword}`);

      // Search for stage records matching these names
      const stageIds: number[] = [];

      for (const stageName of stageNames) {
        const matchingIds = await findMatchingRecords(stageName, 'crm.stage');
        stageIds.push(...matchingIds);
      }

      // Deduplicate
      const uniqueStageIds = [...new Set(stageIds)];

      if (uniqueStageIds.length > 0) {
        console.error(`[FieldMatcher] Found ${uniqueStageIds.length} matching stage IDs for "${keyword}"`);
        return {
          originalEntity: entity,
          fieldName: 'stage_id_id',
          operator: 'in',
          value: uniqueStageIds,
          confidence: 0.9, // High confidence for explicit stage keyword
          source: 'direct_lookup',
          relatedRecords: uniqueStageIds.slice(0, 5).map((id) => ({
            id,
            name: keyword,
            model: 'crm.stage',
          })),
        };
      }

      // If no stage records found by name search, try semantic search
      const similarStages = await findRecordsBySimilarity(keyword, 'crm.stage', 5);
      if (similarStages.length > 0) {
        console.error(`[FieldMatcher] Found ${similarStages.length} similar stages for "${keyword}"`);
        return {
          originalEntity: entity,
          fieldName: 'stage_id_id',
          operator: 'in',
          value: similarStages.map((s) => s.id),
          confidence: 0.75,
          source: 'direct_lookup',
          relatedRecords: similarStages.slice(0, 5).map((s) => ({
            id: s.id,
            name: s.name,
            model: 'crm.stage',
          })),
        };
      }

      // No stages found - still return a hint that this is a stage filter
      // Use 'eq' operator instead of 'contains' to avoid TEXT index requirement
      console.error(`[FieldMatcher] No stage records found for "${keyword}", using name filter with eq`);
      return {
        originalEntity: entity,
        fieldName: 'stage_id_name',
        operator: 'eq',
        value: keyword.charAt(0).toUpperCase() + keyword.slice(1), // Capitalize for matching
        confidence: 0.6, // Lower confidence since exact match is less flexible
        source: 'direct_lookup',
      };
    }
  }

  return null;
}

// =============================================================================
// ENTITY CLASSIFICATION
// =============================================================================

/**
 * Determine if an entity looks like a value that should be searched in data
 * vs a keyword that describes a field type
 */
function isLikelyValue(entity: string): boolean {
  // Proper nouns (capitalized) are likely values (names, places)
  if (/^[A-Z][a-z]+/.test(entity)) {
    return true;
  }

  // Numbers or codes are likely values
  if (/\d/.test(entity)) {
    return true;
  }

  // Short strings (1-2 words) starting with capital are likely names
  const words = entity.split(/\s+/);
  if (words.length <= 2 && /^[A-Z]/.test(entity)) {
    return true;
  }

  return false;
}

/**
 * Determine which FK field this entity might be targeting
 */
function identifyLikelyFKField(entity: string, domain: Domain): string | null {
  const lowerEntity = entity.toLowerCase();

  // Location/geography indicators
  if (
    /\b(state|province|region|territory)\b/i.test(lowerEntity) ||
    ['victoria', 'nsw', 'qld', 'wa', 'sa', 'tas', 'act', 'nt'].some((s) =>
      lowerEntity.includes(s)
    )
  ) {
    return 'state_id';
  }

  // Country indicators
  if (/\b(country|nation|australia|usa|uk|canada)\b/i.test(lowerEntity)) {
    return 'country_id';
  }

  // Account/expense indicators (financial domain)
  if (domain === 'financial') {
    if (/\b(expense|cost|welfare|salary|fee|training|travel)\b/i.test(lowerEntity)) {
      return 'account_id';
    }
  }

  // Partner/customer indicators
  if (/\b(partner|customer|client|vendor|supplier)\b/i.test(lowerEntity)) {
    return 'partner_id';
  }

  // Product indicators (inventory domain)
  if (domain === 'inventory') {
    if (/\b(product|item|sku|variant)\b/i.test(lowerEntity)) {
      return 'product_id';
    }
  }

  // Stage indicators (CRM domain)
  if (domain === 'crm') {
    if (/\b(stage|phase|status|won|lost|new|qualified)\b/i.test(lowerEntity)) {
      return 'stage_id';
    }
  }

  return null;
}

// =============================================================================
// SCHEMA-BASED FIELD DISCOVERY
// =============================================================================

/**
 * Search schema to find fields matching an entity description
 */
async function findFieldInSchema(
  entity: string,
  modelName?: string
): Promise<
  Array<{
    fieldName: string;
    modelName: string;
    fieldType: string;
    confidence: number;
  }>
> {
  try {
    const embedding = await embed(entity, 'query');
    if (!embedding) {
      console.error('[FieldMatcher] Failed to embed entity:', entity);
      return [];
    }

    // Build filter for schema search (using SchemaFilter format)
    const filter = modelName ? { model_name: modelName } : undefined;

    const results = await searchByPointType(embedding, {
      limit: 10,
      minScore: 0.5,
      filter,
      pointType: 'schema',
    });

    return results.map((r) => ({
      fieldName: (r.payload as Record<string, unknown>)?.field_name as string,
      modelName: (r.payload as Record<string, unknown>)?.model_name as string,
      fieldType: (r.payload as Record<string, unknown>)?.field_type as string,
      confidence: r.score,
    }));
  } catch (error) {
    console.error('[FieldMatcher] Schema search error:', error);
    return [];
  }
}

// =============================================================================
// DATA-BASED VALUE RESOLUTION
// =============================================================================

/**
 * Search data to find records matching an entity value
 * Used for resolving names to IDs (e.g., "Hansen" → partner_id=286798)
 */
async function findMatchingRecords(
  entity: string,
  targetModel: string,
  searchField: string = 'name'
): Promise<number[]> {
  try {
    // Use payload filter search for contains match
    const recordIds = await searchByPayloadFilter(
      targetModel,
      searchField,
      'contains',
      entity,
      100 // Limit to 100 matches
    );

    console.error(
      `[FieldMatcher] Found ${recordIds.length} ${targetModel} records matching "${entity}"`
    );
    return recordIds;
  } catch (error) {
    console.error('[FieldMatcher] Data search error:', error);
    return [];
  }
}

/**
 * Search data using semantic similarity to find matching records
 */
async function findRecordsBySimilarity(
  entity: string,
  targetModel: string,
  limit: number = 10
): Promise<Array<{ id: number; name: string; score: number }>> {
  try {
    const embedding = await embed(entity, 'query');
    if (!embedding) {
      return [];
    }

    const results = await searchByPointType(embedding, {
      limit,
      minScore: 0.6,
      filter: { model_name: targetModel },
      pointType: 'data',
    });

    return results.map((r) => ({
      id: (r.payload as Record<string, unknown>)?.record_id as number,
      name:
        ((r.payload as Record<string, unknown>)?.name as string) ||
        ((r.payload as Record<string, unknown>)?.display_name as string) ||
        'Unknown',
      score: r.score,
    }));
  } catch (error) {
    console.error('[FieldMatcher] Similarity search error:', error);
    return [];
  }
}

// =============================================================================
// MAIN FIELD MATCHER FUNCTION
// =============================================================================

/**
 * Match an entity to a field filter
 *
 * @param entity - The entity text to resolve (e.g., "staff welfare", "Hansen")
 * @param domain - The detected domain context
 * @param targetModel - Optional target model for the filter
 * @returns FieldResolution or null if no match found
 *
 * @example
 * matchField("staff welfare", "financial", "account.move.line")
 * // Returns: { fieldName: "account_id_id", operator: "in", value: [427, 428] }
 */
export async function matchField(
  entity: string,
  domain: Domain,
  targetModel?: string
): Promise<FieldResolution | null> {
  console.error(`[FieldMatcher] Matching entity: "${entity}", domain: ${domain}`);

  // Skip very short entities
  if (entity.length < 2) {
    return null;
  }

  // Step 0: Check for CRM stage keywords first (won, lost, new, qualified, etc.)
  // This takes priority because stage keywords are very specific
  const stageResolution = await resolveStageKeyword(entity, domain);
  if (stageResolution) {
    console.error(`[FieldMatcher] Resolved as stage keyword: ${entity} → ${stageResolution.fieldName}`);
    return stageResolution;
  }

  // Step 1: Identify if this looks like a value or a keyword
  const isValue = isLikelyValue(entity);
  console.error(`[FieldMatcher] isLikelyValue: ${isValue}`);

  // Step 2: Try to identify which FK field this might target
  const likelyFKField = identifyLikelyFKField(entity, domain);
  console.error(`[FieldMatcher] likelyFKField: ${likelyFKField}`);

  // Step 3: If we identified a likely FK field, search for matching records
  if (likelyFKField && FK_TARGET_MODELS[likelyFKField]) {
    const fkTargetModel = FK_TARGET_MODELS[likelyFKField];

    // Try exact/contains match first
    let matchingIds = await findMatchingRecords(entity, fkTargetModel);

    // If no matches, try semantic similarity
    if (matchingIds.length === 0) {
      const similarRecords = await findRecordsBySimilarity(entity, fkTargetModel, 5);
      matchingIds = similarRecords.map((r) => r.id);

      if (similarRecords.length > 0) {
        console.error(
          `[FieldMatcher] Found similar records: ${JSON.stringify(similarRecords.slice(0, 3))}`
        );
      }
    }

    if (matchingIds.length > 0) {
      // For Odoo filters, the FK field needs _id suffix
      const filterField = likelyFKField.endsWith('_id')
        ? `${likelyFKField}_id`
        : `${likelyFKField}_id`;

      return {
        originalEntity: entity,
        fieldName: filterField,
        operator: 'in',
        value: matchingIds,
        confidence: 0.8,
        source: 'direct_lookup',
        relatedRecords: matchingIds.slice(0, 5).map((id) => ({
          id,
          name: entity, // Will be enriched later
          model: fkTargetModel,
        })),
      };
    }
  }

  // Step 4: If it's a likely value (proper noun), search for matching partners/entities
  if (isValue) {
    // Try res.partner first (most common FK target)
    const partnerMatches = await findMatchingRecords(entity, 'res.partner');
    if (partnerMatches.length > 0) {
      return {
        originalEntity: entity,
        fieldName: 'partner_id_id',
        operator: 'in',
        value: partnerMatches,
        confidence: 0.75,
        source: 'direct_lookup',
        relatedRecords: partnerMatches.slice(0, 5).map((id) => ({
          id,
          name: entity,
          model: 'res.partner',
        })),
      };
    }

    // Try account.account for financial domain
    if (domain === 'financial') {
      const accountMatches = await findMatchingRecords(entity, 'account.account');
      if (accountMatches.length > 0) {
        return {
          originalEntity: entity,
          fieldName: 'account_id_id',
          operator: 'in',
          value: accountMatches,
          confidence: 0.75,
          source: 'direct_lookup',
          relatedRecords: accountMatches.slice(0, 5).map((id) => ({
            id,
            name: entity,
            model: 'account.account',
          })),
        };
      }
    }
  }

  // Step 5: Search schema to find matching fields
  const schemaMatches = await findFieldInSchema(entity, targetModel);

  if (schemaMatches.length > 0) {
    const bestMatch = schemaMatches[0];

    // If it's a many2one field, we might need to search the target model
    if (bestMatch.fieldType === 'many2one') {
      console.error(`[FieldMatcher] Found many2one field: ${bestMatch.fieldName}`);
      // Return field info without value - needs further resolution
      return {
        originalEntity: entity,
        fieldName: bestMatch.fieldName,
        operator: 'eq',
        value: null, // Will need further resolution
        confidence: bestMatch.confidence * 0.8, // Reduce confidence since value not resolved
        source: 'schema_search',
      };
    }

    // For text fields, use 'eq' operator to avoid TEXT index requirement
    // Note: This is less flexible but more reliable across all Qdrant configurations
    if (['char', 'text', 'html'].includes(bestMatch.fieldType)) {
      console.error(`[FieldMatcher] Text field "${bestMatch.fieldName}" matched, using eq operator`);
      return {
        originalEntity: entity,
        fieldName: bestMatch.fieldName,
        operator: 'eq',
        value: entity,
        confidence: bestMatch.confidence * 0.7, // Lower confidence for exact text match
        source: 'schema_search',
      };
    }
  }

  // No match found
  console.error(`[FieldMatcher] No match found for entity: "${entity}"`);
  return null;
}

/**
 * Match multiple entities to field filters
 *
 * @param entities - Array of entity texts to resolve
 * @param domain - The detected domain context
 * @param targetModel - Optional target model for the filters
 * @returns Array of FieldResolutions
 */
export async function matchFields(
  entities: string[],
  domain: Domain,
  targetModel?: string
): Promise<FieldResolution[]> {
  const results: FieldResolution[] = [];

  for (const entity of entities) {
    const resolution = await matchField(entity, domain, targetModel);
    if (resolution) {
      results.push(resolution);
    }
  }

  // Deduplicate by field name (keep highest confidence)
  const byField = new Map<string, FieldResolution>();
  for (const r of results) {
    const existing = byField.get(r.fieldName);
    if (!existing || r.confidence > existing.confidence) {
      byField.set(r.fieldName, r);
    }
  }

  return Array.from(byField.values());
}

/**
 * Check if an entity should be processed for field matching
 * Filters out date expressions, model names, and other special patterns
 */
export function shouldMatchField(entity: string): boolean {
  // Skip if it looks like a date
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(entity)) {
    return false;
  }
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(entity)) {
    return false;
  }
  if (/^Q[1-4]/i.test(entity)) {
    return false;
  }
  if (/^FY\d/i.test(entity)) {
    return false;
  }

  // Skip if it looks like a model name
  if (/^[a-z]+\.[a-z]+(\.[a-z]+)?$/.test(entity)) {
    return false;
  }

  // Skip common keywords that aren't values
  const skipKeywords = [
    'total',
    'sum',
    'count',
    'average',
    'show',
    'list',
    'find',
    'get',
    'all',
    'by',
    'for',
    'in',
    'the',
  ];
  if (skipKeywords.includes(entity.toLowerCase())) {
    return false;
  }

  return true;
}
