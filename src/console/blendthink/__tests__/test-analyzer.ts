/**
 * Test script for QuestionAnalyzer
 *
 * Run with: npx tsx src/console/blendthink/__tests__/test-analyzer.ts
 */

import { QuestionAnalyzer } from '../question-analyzer.js';
import { AdaptiveRouter } from '../adaptive-router.js';
import { PersonaSelector } from '../persona-selector.js';

// Test queries covering all question types
const TEST_QUERIES = [
  // Precise queries
  "What is the balance of account 123?",
  "Get me record id:45678",
  "Show me the details of partner ABC Corp",

  // Discovery
  "Find hospital projects in Victoria",
  "Search for similar leads to Hansen Yuncken",
  "List all partners like Wadsworth",

  // Aggregation
  "What is the total revenue?",
  "Count all invoices this month",
  "Average order value by customer",

  // Aggregation with discovery
  "Total revenue for hospital projects in Victoria",
  "Sum of invoices for clients similar to Hansen",
  "Count leads related to construction in Sydney",

  // Relationship
  "How is partner 286798 connected to other records?",
  "Show me the FK relationships for crm.lead",
  "What records reference this invoice?",

  // Explanation
  "Why did this variance occur?",
  "Explain the difference in Q1 vs Q2",
  "What caused the revenue drop?",

  // Comparison
  "Compare Q1 vs Q2 performance",
  "Difference between this year and last year",
  "Hansen Yuncken vs Wadsworth revenue",

  // Unknown / needs clarification
  "Help me",
  "What?",
  "Show me stuff",
];

async function runTests() {
  console.log('='.repeat(80));
  console.log('BLENDTHINK QUESTION ANALYZER TEST');
  console.log('='.repeat(80));
  console.log('');

  const analyzer = new QuestionAnalyzer();
  const router = new AdaptiveRouter();
  const personaSelector = new PersonaSelector();

  const results: Array<{
    query: string;
    type: string;
    confidence: number;
    entities: string[];
    route: string;
    persona: string;
  }> = [];

  for (const query of TEST_QUERIES) {
    const analysis = await analyzer.analyze(query);
    const routePlan = router.createPlan(analysis);
    const persona = personaSelector.selectPersona(analysis);

    results.push({
      query: query.substring(0, 50),
      type: analysis.type,
      confidence: analysis.confidence,
      entities: analysis.entities.slice(0, 3),
      route: routePlan.steps.map(s => s.section).join(' → '),
      persona: persona.name,
    });

    // Print each result
    console.log(`Query: "${query}"`);
    console.log(`  Type: ${analysis.type} (${(analysis.confidence * 100).toFixed(0)}% confidence)`);
    console.log(`  Entities: ${analysis.entities.join(', ') || '(none)'}`);
    console.log(`  Route: ${routePlan.steps.map(s => `${s.section}/${s.tool}`).join(' → ')}`);
    console.log(`  Persona: ${persona.name}`);
    if (analysis.needsClarification) {
      console.log(`  ⚠️  Needs clarification: ${analysis.clarificationQuestions?.join(', ')}`);
    }
    console.log('');
  }

  // Summary table
  console.log('='.repeat(80));
  console.log('SUMMARY BY QUESTION TYPE');
  console.log('='.repeat(80));

  const typeCount: Record<string, number> = {};
  for (const result of results) {
    typeCount[result.type] = (typeCount[result.type] || 0) + 1;
  }

  console.log('');
  console.log('| Question Type              | Count |');
  console.log('|----------------------------|-------|');
  for (const [type, count] of Object.entries(typeCount).sort((a, b) => b[1] - a[1])) {
    console.log(`| ${type.padEnd(26)} | ${count.toString().padStart(5)} |`);
  }
  console.log('');

  // Confidence distribution
  console.log('='.repeat(80));
  console.log('CONFIDENCE DISTRIBUTION');
  console.log('='.repeat(80));
  console.log('');

  const highConf = results.filter(r => r.confidence >= 0.8).length;
  const medConf = results.filter(r => r.confidence >= 0.5 && r.confidence < 0.8).length;
  const lowConf = results.filter(r => r.confidence < 0.5).length;

  console.log(`High (≥80%):  ${highConf} queries`);
  console.log(`Medium (50-79%): ${medConf} queries`);
  console.log(`Low (<50%):   ${lowConf} queries`);
  console.log('');

  // Persona distribution
  console.log('='.repeat(80));
  console.log('PERSONA DISTRIBUTION');
  console.log('='.repeat(80));
  console.log('');

  const personaCount: Record<string, number> = {};
  for (const result of results) {
    personaCount[result.persona] = (personaCount[result.persona] || 0) + 1;
  }

  for (const [persona, count] of Object.entries(personaCount).sort((a, b) => b[1] - a[1])) {
    console.log(`${persona}: ${count} queries`);
  }

  console.log('');
  console.log('='.repeat(80));
  console.log('TEST COMPLETE');
  console.log('='.repeat(80));
}

// Run tests
runTests().catch(console.error);
