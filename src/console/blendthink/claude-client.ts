/**
 * Blendthink Claude Client
 *
 * Handles Claude API integration for synthesizing section results
 * into coherent, source-attributed responses.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  BlendSection,
  ConversationTurn,
  PersonaDefinition,
} from '../../common/types.js';
import type { SectionResult } from './section-adapters/types.js';
import { getBlendthinkConfig } from './config.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result of Claude synthesis
 */
export interface SynthesisResult {
  /** The synthesized response text */
  response: string;

  /** Token usage */
  tokenUsage: {
    input: number;
    output: number;
  };

  /** Sources cited in the response */
  sources: Array<{
    section: BlendSection;
    tool: string;
    contribution: string;
    dataPoints?: number;
  }>;
}

/**
 * Options for synthesis
 */
export interface SynthesisOptions {
  /** Maximum tokens in response */
  maxTokens?: number;

  /** Temperature (0-1) */
  temperature?: number;

  /** Stop sequences */
  stopSequences?: string[];
}

// =============================================================================
// CLAUDE CLIENT
// =============================================================================

export class BlendthinkClaudeClient {
  private client: Anthropic;
  private model: string;

  constructor() {
    const config = getBlendthinkConfig();

    // Initialize Anthropic client
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    this.model = config.claudeModel;
  }

  /**
   * Synthesize section results into a coherent response
   *
   * @param systemPrompt - Persona system prompt
   * @param sectionResults - Results from section adapters
   * @param conversationHistory - Previous conversation turns
   * @param options - Synthesis options
   * @returns Synthesized response with sources
   */
  async synthesize(
    systemPrompt: string,
    sectionResults: SectionResult[],
    conversationHistory: ConversationTurn[],
    options: SynthesisOptions = {}
  ): Promise<SynthesisResult> {
    // Build context from section results
    let contextDocument = this.buildContextDocument(sectionResults);

    // Log initial context size
    const initialTokens = this.estimateTokens(contextDocument);
    console.error(
      `[ClaudeClient] Initial context: ~${initialTokens} tokens (${contextDocument.length} chars)`
    );

    // Check if context exceeds token budget and truncate if needed
    if (initialTokens > BlendthinkClaudeClient.MAX_CONTEXT_TOKENS) {
      contextDocument = this.truncateContext(
        contextDocument,
        BlendthinkClaudeClient.MAX_CONTEXT_TOKENS
      );
    }

    // Build messages from conversation history
    const messages = this.buildMessages(conversationHistory, contextDocument);

    // Estimate total tokens before API call
    const systemTokens = this.estimateTokens(systemPrompt);
    const messageTokens = this.estimateTokens(JSON.stringify(messages));
    const totalEstimate = systemTokens + messageTokens;
    console.error(
      `[ClaudeClient] Estimated total: ~${totalEstimate} tokens (system: ${systemTokens}, messages: ${messageTokens})`
    );

    // Call Claude API
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens || 2000,
      temperature: options.temperature || 0.7,
      system: systemPrompt,
      messages,
      stop_sequences: options.stopSequences,
    });

    // Extract response text
    const responseText = response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n');

    // Parse sources from response
    const sources = this.parseSources(responseText, sectionResults);

    return {
      response: responseText,
      tokenUsage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
      sources,
    };
  }

  /**
   * Quick synthesis without full context (for clarification)
   */
  async askClarification(
    question: string,
    persona: PersonaDefinition
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 500,
      temperature: 0.5,
      system: persona.systemPrompt,
      messages: [
        {
          role: 'user',
          content: question,
        },
      ],
    });

    return response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n');
  }

  /**
   * Simple text completion (used by continuous integration engine)
   *
   * @param prompt - The prompt to complete
   * @param options - Completion options
   * @returns Response text
   */
  async complete(
    prompt: string,
    options: { maxTokens?: number; temperature?: number } = {}
  ): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens || 1000,
      temperature: options.temperature || 0.7,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    return response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block as { type: 'text'; text: string }).text)
      .join('\n');
  }

  // ===========================================================================
  // CONTEXT BUILDING
  // ===========================================================================

  /**
   * Build context document from section results
   */
  private buildContextDocument(sectionResults: SectionResult[]): string {
    const sections: string[] = [];

    for (const result of sectionResults) {
      if (!result.success) {
        sections.push(
          `## ${result.section}/${result.tool} (FAILED)\nError: ${result.error}`
        );
        continue;
      }

      const header = `## ${result.section}/${result.tool}`;
      const stats = result.recordCount
        ? `Records: ${result.recordCount} | Tokens: ~${result.tokenEstimate}`
        : `Tokens: ~${result.tokenEstimate}`;

      let content: string;
      if (typeof result.data === 'string') {
        content = result.data;
      } else if (result.data && typeof result.data === 'object') {
        content = JSON.stringify(result.data, null, 2);
      } else {
        content = '(no data)';
      }

      sections.push(`${header}\n${stats}\n\n\`\`\`json\n${content}\n\`\`\``);
    }

    return sections.join('\n\n---\n\n');
  }

  // ===========================================================================
  // TOKEN MANAGEMENT
  // ===========================================================================

  /**
   * Maximum context tokens to send to Claude API
   *
   * Claude's limit is 200k tokens total. We need room for:
   * - System prompt: ~10k tokens (enhanced Forensic Analyst)
   * - Conversation history: ~5k tokens
   * - Response generation: ~4k tokens
   * - Safety margin: ~11k tokens
   *
   * Conservative limit: 100k tokens for context
   * Using 1 token per 3 chars (more conservative than 1:4)
   */
  private static readonly MAX_CONTEXT_TOKENS = 100000;
  private static readonly CHARS_PER_TOKEN = 3; // More conservative estimate

  /**
   * Estimate token count from text
   * Conservative estimate: 1 token per 3 characters (safer for Claude's tokenizer)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / BlendthinkClaudeClient.CHARS_PER_TOKEN);
  }

  /**
   * Truncate context to fit within token budget
   * Preserves structure by truncating from the end
   */
  private truncateContext(context: string, maxTokens: number): string {
    const maxChars = maxTokens * BlendthinkClaudeClient.CHARS_PER_TOKEN;
    if (context.length <= maxChars) return context;

    const estimatedTokens = this.estimateTokens(context);
    console.error(
      `[ClaudeClient] Context too large (~${estimatedTokens} tokens, ${context.length} chars), truncating to ~${maxTokens} tokens...`
    );

    // Truncate and add notice
    const truncated = context.substring(0, maxChars - 300);

    // Try to end at a section boundary for cleaner truncation
    const lastSectionBreak = truncated.lastIndexOf('\n\n---\n\n');
    const cleanTruncated =
      lastSectionBreak > maxChars * 0.5
        ? truncated.substring(0, lastSectionBreak)
        : truncated;

    return (
      cleanTruncated +
      '\n\n---\n\n## [TRUNCATED]\n\n**Note:** Additional context was truncated due to token limits. The data above represents a partial view. Ask follow-up questions for specific details.'
    );
  }

  /**
   * Build message array from conversation history
   */
  private buildMessages(
    history: ConversationTurn[],
    contextDocument: string
  ): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = [];

    // Add conversation history
    for (const turn of history.slice(-10)) {
      // Last 10 turns
      messages.push({
        role: turn.role,
        content: turn.content,
      });
    }

    // Ensure last message is from user with context
    const lastUserTurn = history.filter((t) => t.role === 'user').slice(-1)[0];
    if (lastUserTurn) {
      // Replace or append context to last user message
      const lastIndex = messages.findIndex(
        (m) => m.role === 'user' && m.content === lastUserTurn.content
      );

      if (lastIndex >= 0) {
        messages[lastIndex] = {
          role: 'user',
          content: `${lastUserTurn.content}\n\n---\n\n# Retrieved Context\n\n${contextDocument}`,
        };
      }
    } else {
      // No user message, add context as new user message
      messages.push({
        role: 'user',
        content: `# Retrieved Context\n\n${contextDocument}\n\nPlease analyze this data and provide insights.`,
      });
    }

    return messages;
  }

  // ===========================================================================
  // SOURCE PARSING
  // ===========================================================================

  /**
   * Parse source attributions from response
   */
  private parseSources(
    response: string,
    sectionResults: SectionResult[]
  ): SynthesisResult['sources'] {
    const sources: SynthesisResult['sources'] = [];

    // Pattern: [Source: section/tool]
    const sourcePattern = /\[Source:\s*([a-z]+)\/([a-z_]+)\]/gi;
    const matches = response.matchAll(sourcePattern);

    const seenSources = new Set<string>();

    for (const match of matches) {
      const section = match[1] as BlendSection;
      const tool = match[2];
      const key = `${section}/${tool}`;

      if (seenSources.has(key)) continue;
      seenSources.add(key);

      // Find matching section result
      const result = sectionResults.find(
        (r) => r.section === section && r.tool === tool
      );

      sources.push({
        section,
        tool,
        contribution: result?.success ? 'provided data' : 'failed',
        dataPoints: result?.recordCount,
      });
    }

    // Add any successful results not explicitly cited
    for (const result of sectionResults) {
      const key = `${result.section}/${result.tool}`;
      if (!seenSources.has(key) && result.success && result.recordCount) {
        sources.push({
          section: result.section,
          tool: result.tool,
          contribution: 'provided background data',
          dataPoints: result.recordCount,
        });
      }
    }

    return sources;
  }
}

// =============================================================================
// SINGLETON ACCESS
// =============================================================================

let clientInstance: BlendthinkClaudeClient | null = null;

/**
 * Get or create the Claude client instance
 */
export function getClaudeClient(): BlendthinkClaudeClient {
  if (!clientInstance) {
    clientInstance = new BlendthinkClaudeClient();
  }
  return clientInstance;
}

/**
 * Check if Claude API is available
 */
export function isClaudeAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
