/**
 * Question Analyzer for Blendthink
 *
 * Classifies user queries into question types and extracts
 * actionable information (entities, operations, field hints).
 *
 * Phase 1: Uses pattern matching for classification
 * Phase 2: Will add Claude API for complex/ambiguous queries
 */

import type { QuestionAnalysis, QuestionType } from '../../common/types.js';

// Anthropic SDK is optional - will be used in Phase 2
// import Anthropic from '@anthropic-ai/sdk';
type Anthropic = unknown; // Placeholder for Phase 2

// =============================================================================
// PATTERN MATCHING RULES
// =============================================================================

/**
 * Pattern rules for fast classification without API call
 */
interface PatternRule {
  /** Regex patterns to match */
  patterns: RegExp[];
  /** Question type if matched */
  type: QuestionType;
  /** Base confidence for pattern match */
  confidence: number;
  /** Operation to extract (if any) */
  operation?: string;
}

// =============================================================================
// DRILLDOWN PATTERNS
// =============================================================================

/**
 * Drilldown operation types that work on cached session data
 */
type DrilldownOperation = 'regroup' | 'expand' | 'export' | 'filter' | 'sort';

/**
 * Drilldown pattern definition
 */
interface DrilldownPattern {
  /** Regex patterns to match */
  patterns: RegExp[];
  /** Operation type */
  operation: DrilldownOperation;
  /** Whether this pattern extracts a field/value */
  extractsField?: boolean;
  /** Confidence boost for this pattern */
  confidence: number;
}

/**
 * Patterns that indicate drilldown operations on previous results
 */
const DRILLDOWN_PATTERNS: DrilldownPattern[] = [
  // Regroup: Change GROUP BY field
  {
    patterns: [
      /^show\s+(me\s+)?(this\s+|that\s+)?by\s+(\w+)/i, // "show me by customer"
      /^(break\s*down|breakdown)\s+(this\s+|that\s+)?by\s+(\w+)/i, // "break down by account"
      /^group\s+(this\s+|that\s+)?by\s+(\w+)/i, // "group by partner"
      /^regroup\s+(by\s+)?(\w+)/i, // "regroup by month"
      /^(now\s+)?(show|display)\s+(it\s+)?by\s+(\w+)/i, // "now show it by vendor"
      /^instead\s+(show\s+)?(me\s+)?by\s+(\w+)/i, // "instead show by product"
      /^(what\s+about|how\s+about)\s+by\s+(\w+)/i, // "what about by category"
      /^same\s+(data|thing|results?)\s+by\s+(\w+)/i, // "same data by journal"
    ],
    operation: 'regroup',
    extractsField: true,
    confidence: 0.9,
  },

  // Export: Download cached data
  {
    patterns: [
      /^export\s+(this|that|these|it)?/i, // "export this"
      /^download\s+(this|that|these|it)?/i, // "download this"
      /^(save|write)\s+(this|that)?\s*(to|as)\s+(excel|csv|file)/i, // "save to excel"
      /^(can\s+you\s+)?export\s+(to\s+)?(excel|csv)/i, // "can you export to excel"
      /^get\s+(me\s+)?(an?\s+)?(excel|csv)/i, // "get me an excel"
      /^(i\s+)?(want|need)\s+(this\s+)?(in|as)\s+(excel|csv)/i, // "I need this in excel"
    ],
    operation: 'export',
    extractsField: false,
    confidence: 0.95,
  },

  // Expand: Show underlying detail records
  {
    patterns: [
      /^(show|what|list)\s+(me\s+)?(the\s+)?(detail|details|underlying|breakdown)/i, // "show me the details"
      /^(what|show)\s+(are\s+)?(the\s+)?(invoices?|entries|records?|transactions?|lines?)\s+(for|in|making\s+up)/i, // "what invoices are in this"
      /^drill\s*(down|into)/i, // "drill down"
      /^expand\s+(this|that|the|these)?/i, // "expand this"
      /^(show|give)\s+(me\s+)?(the\s+)?(underlying|source)\s+(data|records)/i, // "show underlying records"
      /^what\s+(makes?\s+up|comprises?|is\s+in)/i, // "what makes up this total"
      /^(break|split)\s+(this\s+)?open/i, // "break this open"
    ],
    operation: 'expand',
    extractsField: false,
    confidence: 0.85,
  },

  // Filter: Add additional filter to cached data
  {
    patterns: [
      /^(but\s+)?(only|just)\s+(for|show|include)\s+/i, // "but only for partner X"
      /^filter\s+(this\s+|that\s+)?(to|for|by)\s+/i, // "filter this to March"
      /^(narrow|limit)\s+(this\s+)?(to|down)/i, // "narrow this to Q1"
      /^(show\s+)?(me\s+)?only\s+/i, // "show me only posted"
      /^exclude\s+/i, // "exclude draft entries"
      /^(where|when|if)\s+/i, // "where partner is X" (context-dependent)
    ],
    operation: 'filter',
    extractsField: true,
    confidence: 0.8,
  },

  // Sort: Re-sort cached data
  {
    patterns: [
      /^sort\s+(this\s+|that\s+)?(by\s+)?(\w+)/i, // "sort by amount"
      /^order\s+(this\s+|that\s+)?by\s+(\w+)/i, // "order by date"
      /^(show\s+)?(highest|lowest|top|bottom)\s+(first|\d+)/i, // "show highest first"
      /^(ascending|descending|asc|desc)/i, // "descending"
      /^(reverse|flip)\s+(the\s+)?(order|sort)/i, // "reverse the order"
    ],
    operation: 'sort',
    extractsField: true,
    confidence: 0.85,
  },
];

/**
 * Mapping of natural language terms to Odoo field names for drilldown
 * Extends the GROUP BY mappings for regroup operations
 */
const DRILLDOWN_FIELD_MAPPINGS: Record<string, string> = {
  // Partner/Customer fields
  partner: 'partner_id_id',
  customer: 'partner_id_id',
  vendor: 'partner_id_id',
  supplier: 'partner_id_id',
  client: 'partner_id_id',

  // Account fields
  account: 'account_id_id',
  gl: 'account_id_id',
  ledger: 'account_id_id',

  // Product fields
  product: 'product_id_id',
  item: 'product_id_id',

  // User fields
  user: 'user_id_id',
  salesperson: 'user_id_id',
  salesman: 'user_id_id',
  assigned: 'user_id_id',
  owner: 'user_id_id',

  // Stage/Status fields
  stage: 'stage_id_id',
  status: 'state',
  state: 'state',

  // Category fields
  category: 'categ_id_id',
  type: 'type',

  // Location fields
  region: 'state_id_id',
  country: 'country_id_id',

  // Journal fields
  journal: 'journal_id_id',

  // Date/Time groupings (temporal)
  month: 'date',
  year: 'date',
  quarter: 'date',
  week: 'date',
  day: 'date',
  date: 'date',

  // Monetary fields (for sort operations)
  amount: 'amount_total',
  total: 'amount_total',
  debit: 'debit',
  credit: 'credit',
  balance: 'balance',
  revenue: 'expected_revenue',
  value: 'expected_revenue',
};

const PATTERN_RULES: PatternRule[] = [
  // Precise query patterns
  {
    patterns: [
      /^what\s+is\s+the\s+(balance|total|amount|value)\s+(of|for)\s+/i,
      /^get\s+(me\s+)?(the\s+)?record\s+/i,
      /^show\s+(me\s+)?(the\s+)?details\s+(of|for)\s+/i,
      /^show\s+(me\s+)?(the\s+)?balance\s+(of|for)\s+/i,
      /^lookup\s+/i,
      /\bid\s*[=:]\s*\d+/i,
      /^what\s+is\s+record\s+/i,
      // Direct record references: "crm.lead record 41085", "partner 286798"
      /\b(crm\.lead|res\.partner|account\.move|account\.move\.line|product\.template)\s+(record\s+)?\d+/i,
      /\brecord\s+\d+/i,
      /\b(partner|lead|invoice|account)\s+\d+\b/i,
      // Balance queries with account numbers
      /\bbalance\s+(of\s+)?(account|partner|customer)\s+\d+/i,
      /\baccount\s+\d+.*\b(balance|total|debit|credit)\b/i,
    ],
    type: 'precise_query',
    confidence: 0.85,
    operation: 'get',
  },

  // Aggregation patterns
  {
    patterns: [
      /^(what\s+is\s+the\s+)?(total|sum|count|average|avg|min|max)\s+(of\s+)?/i,
      /\b(sum|total|count|average)\s+(all|the)\s+/i,
      /\bgrouped?\s+by\b/i,
      /\bper\s+(partner|account|month|year|category)/i,
      /^how\s+many\s+/i,
      // Added: Financial/accounting patterns
      /^calculate\s+/i, // "Calculate gross margin"
      /\b(margin|markup|ratio|percentage|rate)\b.*\bby\b/i, // Financial metrics by dimension
      /\b(breakdown|distribution)\s+(of|by)\b/i, // "Breakdown of revenue"
      /\bby\s+(product|partner|category|account|region|month|quarter|year|customer|vendor)\b/i, // "X by dimension"
      /\b(revenue|cost|profit|expense|income)\s+by\b/i, // Financial terms + by
    ],
    type: 'aggregation',
    confidence: 0.85,
    operation: 'aggregate',
  },

  // Discovery patterns
  {
    patterns: [
      /^find\s+(me\s+)?(all\s+)?/i,
      /^search\s+for\s+/i,
      /^show\s+(me\s+)?(all\s+)?.*\s+like\s+/i,
      /^list\s+(all\s+)?/i,
      /\bsimilar\s+to\b/i,
      /\brelated\s+to\b/i,
    ],
    type: 'discovery',
    confidence: 0.8,
    operation: 'search',
  },

  // Relationship patterns
  {
    patterns: [
      /^how\s+(is|are)\s+.*\s+connected\s+/i,
      /^what\s+(is|are)\s+the\s+relationship/i,
      /\blinked\s+to\b/i,
      /\breferences?\s+(to|from|this)\b/i,
      /\breference\s+(this|that|the)\b/i,
      /^what\s+(records?|items?|entries?)\s+reference/i,
      /^show\s+(me\s+)?.*\s+connections/i,
      /\bFK\b|\bforeign\s+key/i,
    ],
    type: 'relationship',
    confidence: 0.85,
    operation: 'traverse',
  },

  // Explanation patterns
  {
    patterns: [
      /^why\s+(did|does|is|are|was|were)\s+/i,
      /^explain\s+(why|how)\s+/i,
      /^what\s+caused\s+/i,
      /\bvariance\b.*\bexplain/i,
      /\breason\s+for\b/i,
    ],
    type: 'explanation',
    confidence: 0.8,
    operation: 'explain',
  },

  // Comparison patterns
  {
    patterns: [
      /^compare\s+/i,
      /\bvs\.?\b|\bversus\b/i,
      /\bdifference\s+between\b/i,
      /\bQ[1-4]\s+(vs|and)\s+Q[1-4]/i,
      /\b(this|last)\s+(year|month|quarter)\s+(vs|compared)/i,
    ],
    type: 'comparison',
    confidence: 0.85,
    operation: 'compare',
  },
];

/**
 * Entity extraction patterns
 */
const ENTITY_PATTERNS = {
  // Odoo record IDs - various formats
  recordId: /\b(?:id|record|#)\s*[=:]?\s*(\d+)\b/gi,
  // Entity + number patterns: "partner 286798", "account 319", "lead 41085"
  entityNumber: /\b(partner|account|lead|invoice|order|product|user|company)\s+(\d+)\b/gi,
  // Model + number: "crm.lead 41085"
  modelNumber: /\b(crm\.lead|res\.partner|account\.move|account\.move\.line|product\.template)\s+(?:record\s+)?(\d+)\b/gi,
  // Partner/company names (quoted or capitalized)
  quotedEntity: /"([^"]+)"|'([^']+)'/g,
  capitalizedEntity: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
  // Model names
  modelName: /\b(crm\.lead|res\.partner|account\.move|account\.move\.line|product\.template)\b/gi,
  // Date patterns
  date: /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\b/g,
  // Month + year patterns
  monthYear: /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/gi,
  // Money amounts
  money: /\$[\d,]+(?:\.\d{2})?|\b[\d,]+\s*(?:dollars?|AUD|USD)\b/gi,
  // Location hints
  location: /\b(Victoria|NSW|Queensland|Sydney|Melbourne|Brisbane|Perth|Adelaide)\b/gi,
};

/**
 * Field hint patterns
 *
 * @deprecated These static dictionaries are now LEGACY FALLBACKS.
 * The Entity Resolution Layer (entity-resolution/) handles field discovery
 * dynamically via schema search. These are only used when entity resolution
 * does not return resolved filters.
 *
 * See: src/console/blendthink/entity-resolution/
 */
const FIELD_HINTS = {
  revenue: ['revenue', 'expected_revenue', 'amount_total', 'price_total'],
  balance: ['balance', 'debit', 'credit', 'amount_residual'],
  date: ['date', 'create_date', 'write_date', 'date_order', 'invoice_date'],
  partner: ['partner_id', 'partner_name', 'customer', 'vendor'],
  account: ['account_id', 'account_code', 'account_name'],
  stage: ['stage_id', 'stage_name', 'state'],
  user: ['user_id', 'salesperson', 'assigned_to', 'create_uid'],
};

/**
 * Model hint patterns
 *
 * @deprecated These static dictionaries are now LEGACY FALLBACKS.
 * The Entity Resolution Layer (entity-resolution/model-finder.ts) handles
 * model discovery dynamically via schema semantic search. These are only
 * used when entity resolution does not return a resolved model.
 *
 * See: src/console/blendthink/entity-resolution/model-finder.ts
 */
const MODEL_HINTS: Record<string, string[]> = {
  'crm.lead': ['lead', 'leads', 'opportunity', 'opportunities', 'crm', 'pipeline', 'prospect'],
  'res.partner': ['partner', 'partners', 'customer', 'customers', 'vendor', 'vendors', 'contact', 'contacts', 'company', 'companies'],
  'account.move': ['invoice', 'invoices', 'bill', 'bills', 'journal entry', 'journal entries'],
  'account.move.line': ['journal line', 'journal lines', 'transaction', 'transactions', 'gl', 'general ledger'],
  'product.template': ['product', 'products', 'item', 'items'],
};

// =============================================================================
// QUESTION ANALYZER CLASS
// =============================================================================

export class QuestionAnalyzer {
  private anthropic: Anthropic | null = null;
  private model: string;

  constructor(claudeModel: string = 'claude-sonnet-4-20250514') {
    this.model = claudeModel;

    // Phase 2: Initialize Anthropic client when SDK is added
    // const apiKey = process.env.ANTHROPIC_API_KEY;
    // if (apiKey) {
    //   this.anthropic = new Anthropic({ apiKey });
    // }

    // For Phase 1, rely on pattern matching only
    this.anthropic = null;
  }

  /**
   * Analyze a user query and classify it
   *
   * Uses pattern matching for common cases (fast, no API call).
   * Falls back to Claude API for complex/ambiguous queries.
   */
  async analyze(query: string): Promise<QuestionAnalysis> {
    // Step 1: Try pattern matching first (fast path)
    const patternResult = this.analyzeWithPatterns(query);
    if (patternResult.confidence >= 0.8) {
      return patternResult;
    }

    // Step 2: Use Claude API for complex queries
    if (this.anthropic) {
      try {
        const apiResult = await this.analyzeWithClaude(query);
        return apiResult;
      } catch (error) {
        console.error('[QuestionAnalyzer] Claude API error, using pattern result:', error);
        return patternResult;
      }
    }

    // Step 3: Return pattern result if no API available
    return patternResult;
  }

  /**
   * Fast pattern-based analysis
   */
  private analyzeWithPatterns(query: string): QuestionAnalysis {
    const normalizedQuery = query.trim().toLowerCase();

    // Check for drilldown operation FIRST (highest priority)
    const drilldownResult = this.detectDrilldown(query);

    // Priority pattern checks - some patterns should override others
    // Check relationship FIRST (questions about connections should not be treated as lookups)
    const relationshipRule = PATTERN_RULES.find(r => r.type === 'relationship');
    const isRelationshipQuery = relationshipRule?.patterns.some(p => p.test(query));

    // Check explanation patterns (why/explain questions)
    const explanationRule = PATTERN_RULES.find(r => r.type === 'explanation');
    const isExplanationQuery = explanationRule?.patterns.some(p => p.test(query));

    // Find matching pattern rule
    let matchedRule: PatternRule | null = null;

    // If it's clearly a relationship or explanation query, use that
    if (isRelationshipQuery) {
      matchedRule = relationshipRule!;
    } else if (isExplanationQuery) {
      matchedRule = explanationRule!;
    } else {
      // Otherwise, check patterns in order
      for (const rule of PATTERN_RULES) {
        for (const pattern of rule.patterns) {
          if (pattern.test(query)) {
            matchedRule = rule;
            break;
          }
        }
        if (matchedRule) break;
      }
    }

    // Check for aggregation_with_discovery (hybrid)
    const hasAggregation = PATTERN_RULES[1].patterns.some(p => p.test(query));
    const hasDiscovery = PATTERN_RULES[2].patterns.some(p => p.test(query));
    const hasSemanticTerms = /\b(hospital|project|client|victoria|similar|like)\b/i.test(query);

    let type: QuestionType = matchedRule?.type || 'unknown';
    let confidence = matchedRule?.confidence || 0.3;
    let operation = matchedRule?.operation;

    // Upgrade to aggregation_with_discovery if both patterns match
    if (hasAggregation && (hasDiscovery || hasSemanticTerms)) {
      type = 'aggregation_with_discovery';
      confidence = 0.85;
      operation = 'aggregate_after_search';
    }

    // Extract entities
    const entities = this.extractEntities(query);

    // Boost confidence if we have ID-bearing entities (partner:286798, lead:41085, etc.)
    // This ensures we proceed with data retrieval even for "unknown" query types
    const hasIdEntities = entities.some(e =>
      e.includes(':') && /:\d+$/.test(e)
    );
    if (hasIdEntities && confidence < 0.6) {
      confidence = 0.6; // Minimum 60% if we have specific IDs
    }

    // Extract field hints
    const fieldHints = this.extractFieldHints(normalizedQuery);

    // Extract model hints
    const modelHints = this.extractModelHints(normalizedQuery);

    // Extract GROUP BY hints from "by <field>" patterns
    const groupByHints = this.extractGroupByHints(normalizedQuery);

    // Determine if clarification needed
    const needsClarification = type === 'unknown' || confidence < 0.5;
    const clarificationQuestions = needsClarification
      ? this.generateClarificationQuestions(query, entities)
      : undefined;

    // Calculate complexity score for simple mode bypass
    const complexity = this.calculateComplexity(type, entities, hasAggregation, hasDiscovery);

    // Determine if synthesis can be bypassed (simple mode)
    const canBypassSynthesis = this.canBypassSynthesis(type, complexity, entities);

    // Build the result object
    const result: QuestionAnalysis = {
      query,
      type,
      confidence,
      entities,
      operation,
      fieldHints: fieldHints.length > 0 ? fieldHints : undefined,
      modelHints: modelHints.length > 0 ? modelHints : undefined,
      groupByHints: groupByHints.length > 0 ? groupByHints : undefined,
      needsClarification,
      clarificationQuestions,
      complexity,
      canBypassSynthesis,
    };

    // Add drilldown info if detected
    if (drilldownResult) {
      result.isDrilldown = drilldownResult.isDrilldown;
      result.drilldownOperation = drilldownResult.operation;
      if (drilldownResult.groupBy) {
        result.drilldownGroupBy = drilldownResult.groupBy;
      }
      if (drilldownResult.expandKey) {
        result.drilldownExpandKey = drilldownResult.expandKey;
      }
      // Boost confidence for drilldown operations
      result.confidence = Math.max(result.confidence, drilldownResult.confidence);
      // Drilldown operations are typically simple (use cached data)
      result.complexity = 0.2;
      result.canBypassSynthesis = true; // Drilldowns use cached results, no Claude needed
    }

    return result;
  }

  /**
   * Calculate query complexity score (0-1)
   *
   * Simple (< 0.3): Single record lookup, simple count
   * Medium (0.3-0.7): Multi-record query, basic aggregation
   * Complex (> 0.7): Multi-section, explanation, comparison
   */
  private calculateComplexity(
    type: QuestionType,
    entities: string[],
    hasAggregation: boolean,
    hasDiscovery: boolean
  ): number {
    let complexity = 0.3; // Base complexity

    // Type-based complexity
    switch (type) {
      case 'precise_query':
        complexity = 0.1; // Very simple
        break;
      case 'discovery':
        complexity = 0.4;
        break;
      case 'aggregation':
        complexity = 0.5;
        break;
      case 'aggregation_with_discovery':
        complexity = 0.7;
        break;
      case 'relationship':
        complexity = 0.5;
        break;
      case 'explanation':
        complexity = 0.9; // Always complex
        break;
      case 'comparison':
        complexity = 0.8;
        break;
      case 'unknown':
        complexity = 0.6;
        break;
    }

    // Adjust for entities
    if (entities.length === 1 && entities[0].startsWith('id:')) {
      // Single ID lookup is simpler
      complexity = Math.min(complexity, 0.2);
    } else if (entities.length > 3) {
      // Many entities increases complexity
      complexity = Math.min(1.0, complexity + 0.2);
    }

    // Adjust for hybrid patterns
    if (hasAggregation && hasDiscovery) {
      complexity = Math.max(complexity, 0.6);
    }

    return Math.round(complexity * 100) / 100;
  }

  /**
   * Determine if query can bypass Claude synthesis
   *
   * True for:
   * - Single record lookup by ID
   * - Simple counts with direct filters
   * - Schema lookups
   */
  private canBypassSynthesis(
    type: QuestionType,
    complexity: number,
    entities: string[]
  ): boolean {
    // Always bypass for very simple queries
    if (complexity < 0.25) {
      return true;
    }

    // Precise queries with single ID can bypass
    if (type === 'precise_query' && entities.length === 1 && entities[0].startsWith('id:')) {
      return true;
    }

    // Never bypass for explanation or comparison
    if (type === 'explanation' || type === 'comparison' || type === 'aggregation_with_discovery') {
      return false;
    }

    // Medium complexity can sometimes bypass
    if (complexity < 0.4 && (type === 'precise_query' || type === 'aggregation')) {
      return true;
    }

    return false;
  }

  /**
   * Claude API-based analysis for complex queries
   *
   * Phase 2: Will be implemented when Anthropic SDK is added
   * For now, falls back to pattern matching
   */
  private async analyzeWithClaude(query: string): Promise<QuestionAnalysis> {
    // Phase 2: Uncomment when @anthropic-ai/sdk is installed
    // if (!this.anthropic) {
    //   throw new Error('Anthropic client not initialized');
    // }
    //
    // const systemPrompt = `You are a query classifier...`;
    // const response = await this.anthropic.messages.create({...});
    // ... parse and return

    // For Phase 1, fall back to pattern matching
    console.error('[QuestionAnalyzer] Claude API not available, using pattern matching');
    return this.analyzeWithPatterns(query);
  }

  /**
   * Extract entities from query
   */
  private extractEntities(query: string): string[] {
    const entities: Set<string> = new Set();

    // Extract record IDs (id:123, record 123, #123)
    const idMatches = query.matchAll(ENTITY_PATTERNS.recordId);
    for (const match of idMatches) {
      entities.add(`id:${match[1]}`);
    }

    // Extract entity + number patterns (partner 286798, account 319)
    const entityNumberMatches = query.matchAll(ENTITY_PATTERNS.entityNumber);
    for (const match of entityNumberMatches) {
      const entityType = match[1].toLowerCase();
      const id = match[2];
      entities.add(`${entityType}:${id}`);
    }

    // Extract model + number patterns (crm.lead 41085)
    const modelNumberMatches = query.matchAll(ENTITY_PATTERNS.modelNumber);
    for (const match of modelNumberMatches) {
      const model = match[1].toLowerCase();
      const id = match[2];
      entities.add(`model:${model}`);
      entities.add(`id:${id}`);
    }

    // Extract quoted entities
    const quotedMatches = query.matchAll(ENTITY_PATTERNS.quotedEntity);
    for (const match of quotedMatches) {
      entities.add(match[1] || match[2]);
    }

    // Extract capitalized entities (names)
    const capitalMatches = query.matchAll(ENTITY_PATTERNS.capitalizedEntity);
    for (const match of capitalMatches) {
      // Filter out common words
      const entity = match[1];
      if (!['The', 'What', 'How', 'Why', 'Find', 'Show', 'Get', 'List', 'Compare'].includes(entity.split(' ')[0])) {
        entities.add(entity);
      }
    }

    // Extract model names (without numbers)
    const modelMatches = query.matchAll(ENTITY_PATTERNS.modelName);
    for (const match of modelMatches) {
      entities.add(`model:${match[1].toLowerCase()}`);
    }

    // Extract locations
    const locationMatches = query.matchAll(ENTITY_PATTERNS.location);
    for (const match of locationMatches) {
      entities.add(`location:${match[1]}`);
    }

    // Extract dates (YYYY-MM-DD or DD/MM/YYYY)
    const dateMatches = query.matchAll(ENTITY_PATTERNS.date);
    for (const match of dateMatches) {
      entities.add(`date:${match[1]}`);
    }

    // Extract month + year (March 2025)
    const monthYearMatches = query.matchAll(ENTITY_PATTERNS.monthYear);
    for (const match of monthYearMatches) {
      entities.add(`date:${match[1]} ${match[2]}`);
    }

    // Extract significant keywords for Entity Resolution Layer
    // These are plain words that might be resolved to models/fields dynamically
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
      'into', 'through', 'during', 'before', 'after', 'above', 'below',
      'between', 'under', 'again', 'further', 'then', 'once', 'here',
      'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more',
      'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
      'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
      'because', 'until', 'while', 'what', 'which', 'who', 'whom', 'this',
      'that', 'these', 'those', 'am', 'show', 'find', 'get', 'list', 'me',
      'my', 'i', 'you', 'we', 'they', 'he', 'she', 'it', 'total', 'sum',
      'count', 'average', 'avg', 'minimum', 'min', 'maximum', 'max',
    ]);

    const words = query.toLowerCase().split(/[\s,;:()[\]{}]+/);
    for (const word of words) {
      // Skip stop words, short words, and already-extracted entities
      if (word.length > 2 && !stopWords.has(word)) {
        // Check if this word is already represented in entities
        const alreadyExtracted = Array.from(entities).some(e =>
          e.toLowerCase().includes(word)
        );
        if (!alreadyExtracted) {
          entities.add(word);
        }
      }
    }

    return Array.from(entities);
  }

  /**
   * Extract field hints from query
   */
  private extractFieldHints(normalizedQuery: string): string[] {
    const hints: string[] = [];

    for (const [keyword, fields] of Object.entries(FIELD_HINTS)) {
      if (normalizedQuery.includes(keyword)) {
        hints.push(...fields);
      }
    }

    return [...new Set(hints)];
  }

  /**
   * Extract model hints from query
   */
  private extractModelHints(normalizedQuery: string): string[] {
    const hints: string[] = [];

    for (const [model, keywords] of Object.entries(MODEL_HINTS)) {
      for (const keyword of keywords) {
        if (normalizedQuery.includes(keyword)) {
          hints.push(model);
          break;
        }
      }
    }

    return [...new Set(hints)];
  }

  /**
   * Extract GROUP BY hints from "by <field>" patterns
   *
   * Detects patterns like:
   * - "revenue by partner" → ['partner_id']
   * - "total by account" → ['account_id']
   * - "expenses by month" → ['date'] (temporal grouping)
   * - "breakdown by product" → ['product_id']
   */
  private extractGroupByHints(normalizedQuery: string): string[] {
    const hints: string[] = [];

    // Map of keywords to field names for GROUP BY
    const groupByMappings: Record<string, string> = {
      // Entity FK fields
      partner: 'partner_id_id',
      customer: 'partner_id_id',
      vendor: 'partner_id_id',
      account: 'account_id_id',
      product: 'product_id_id',
      user: 'user_id_id',
      salesperson: 'user_id_id',
      stage: 'stage_id_id',
      category: 'categ_id_id',
      region: 'state_id_id',
      country: 'country_id_id',
      journal: 'journal_id_id',
      // Temporal groupings
      month: 'date',
      year: 'date',
      quarter: 'date',
      week: 'date',
      day: 'date',
    };

    // Pattern: "by <keyword>" - matches "by partner", "by account", etc.
    const byPattern = /\bby\s+(\w+)/gi;
    let match;

    while ((match = byPattern.exec(normalizedQuery)) !== null) {
      const keyword = match[1].toLowerCase();
      const fieldName = groupByMappings[keyword];

      if (fieldName) {
        hints.push(fieldName);
        console.error(`[QuestionAnalyzer] Extracted GROUP BY: "${keyword}" → ${fieldName}`);
      }
    }

    // Also check for "grouped by" patterns
    const groupedByPattern = /\bgrouped?\s+by\s+(\w+)/gi;
    while ((match = groupedByPattern.exec(normalizedQuery)) !== null) {
      const keyword = match[1].toLowerCase();
      const fieldName = groupByMappings[keyword];

      if (fieldName && !hints.includes(fieldName)) {
        hints.push(fieldName);
      }
    }

    // Check for "per <keyword>" patterns
    const perPattern = /\bper\s+(\w+)/gi;
    while ((match = perPattern.exec(normalizedQuery)) !== null) {
      const keyword = match[1].toLowerCase();
      const fieldName = groupByMappings[keyword];

      if (fieldName && !hints.includes(fieldName)) {
        hints.push(fieldName);
      }
    }

    return hints;
  }

  /**
   * Detect if query is a drilldown operation on previous results
   *
   * Returns drilldown info if detected, null otherwise.
   * Drilldown queries work on cached session data without re-querying Qdrant.
   */
  private detectDrilldown(query: string): {
    isDrilldown: boolean;
    operation: DrilldownOperation;
    groupBy?: string[];
    expandKey?: string;
    confidence: number;
  } | null {
    const normalizedQuery = query.trim();
    console.error(`[QuestionAnalyzer] detectDrilldown called with: "${normalizedQuery}"`);

    for (const drilldownPattern of DRILLDOWN_PATTERNS) {
      for (const pattern of drilldownPattern.patterns) {
        const match = pattern.exec(normalizedQuery);
        if (match) {
          const result: {
            isDrilldown: boolean;
            operation: DrilldownOperation;
            groupBy?: string[];
            expandKey?: string;
            confidence: number;
          } = {
            isDrilldown: true,
            operation: drilldownPattern.operation,
            confidence: drilldownPattern.confidence,
          };

          // Extract field for regroup/sort operations
          if (drilldownPattern.extractsField && drilldownPattern.operation === 'regroup') {
            // Find the last capture group that contains a word (the field name)
            const fieldWord = this.extractFieldFromMatch(match, normalizedQuery);
            if (fieldWord) {
              const mappedField = DRILLDOWN_FIELD_MAPPINGS[fieldWord.toLowerCase()];
              if (mappedField) {
                result.groupBy = [mappedField];
                console.error(`[QuestionAnalyzer] Drilldown regroup: "${fieldWord}" → ${mappedField}`);
              } else {
                // Use the raw word as-is (might be a direct field name)
                result.groupBy = [fieldWord];
                console.error(`[QuestionAnalyzer] Drilldown regroup: "${fieldWord}" (unmapped)`);
              }
            }
          }

          // Extract sort field
          if (drilldownPattern.extractsField && drilldownPattern.operation === 'sort') {
            const fieldWord = this.extractFieldFromMatch(match, normalizedQuery);
            if (fieldWord) {
              const mappedField = DRILLDOWN_FIELD_MAPPINGS[fieldWord.toLowerCase()];
              result.groupBy = [mappedField || fieldWord]; // Reuse groupBy for sort field
              console.error(`[QuestionAnalyzer] Drilldown sort by: "${fieldWord}" → ${mappedField || fieldWord}`);
            }
          }

          // Extract expand key (for expand operations, we might need a group key)
          if (drilldownPattern.operation === 'expand') {
            // Look for specific identifiers in the query
            const idMatch = /\b(?:for|in|of)\s+(?:partner|account|product)?\s*#?(\d+)/i.exec(normalizedQuery);
            if (idMatch) {
              result.expandKey = idMatch[1];
              console.error(`[QuestionAnalyzer] Drilldown expand key: ${result.expandKey}`);
            }
          }

          console.error(`[QuestionAnalyzer] Detected drilldown: ${drilldownPattern.operation} (confidence: ${result.confidence})`);
          return result;
        }
      }
    }

    console.error(`[QuestionAnalyzer] No drilldown detected for: "${normalizedQuery}"`);
    return null;
  }

  /**
   * Extract field name from regex match
   * Finds the last non-empty capture group that looks like a field name
   */
  private extractFieldFromMatch(match: RegExpExecArray, query: string): string | null {
    // Try capture groups first (in reverse order to get the last one)
    for (let i = match.length - 1; i >= 1; i--) {
      if (match[i] && /^[a-z_]+$/i.test(match[i])) {
        return match[i];
      }
    }

    // Fallback: extract word after "by" in the query
    const byMatch = /\bby\s+(\w+)/i.exec(query);
    if (byMatch) {
      return byMatch[1];
    }

    return null;
  }

  /**
   * Generate clarification questions for ambiguous queries
   */
  private generateClarificationQuestions(query: string, entities: string[]): string[] {
    const questions: string[] = [];

    // No entities found
    if (entities.length === 0) {
      questions.push('Could you specify which records or entities you\'re looking for?');
    }

    // No model hints
    const hasModelHint = entities.some(e => e.startsWith('model:'));
    if (!hasModelHint) {
      questions.push('Which type of records? (leads, partners, invoices, journal entries)');
    }

    // Ambiguous operation
    if (query.length < 20) {
      questions.push('Could you provide more details about what you\'d like to do?');
    }

    return questions.slice(0, 2); // Max 2 questions
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let analyzerInstance: QuestionAnalyzer | null = null;

/**
 * Get or create the singleton QuestionAnalyzer instance
 */
export function getQuestionAnalyzer(claudeModel?: string): QuestionAnalyzer {
  if (!analyzerInstance) {
    analyzerInstance = new QuestionAnalyzer(claudeModel);
  }
  return analyzerInstance;
}

/**
 * Analyze a query using the singleton analyzer
 */
export async function analyzeQuestion(query: string): Promise<QuestionAnalysis> {
  const analyzer = getQuestionAnalyzer();
  return analyzer.analyze(query);
}
