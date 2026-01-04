/**
 * Test script for BlendthinkEngine
 *
 * Run with: npx tsx src/console/blendthink/__tests__/test-engine.ts
 */

import { BlendthinkEngine } from '../engine.js';

// Test queries representing real-world use cases
const TEST_QUERIES = [
  // Real business questions
  "What is the total expected revenue for hospital projects in Victoria?",
  "Find all partners similar to Hansen Yuncken",
  "Show me the balance of account 319 for March 2025",
  "How is partner 286798 connected to invoices?",
  "Why did revenue drop in Q4?",
  "Compare this year's sales vs last year",

  // Edge cases
  "crm.lead record 41085",
  "List all crm.lead with stage_id = 1",
  "What?",
];

async function runTests() {
  console.log('='.repeat(80));
  console.log('BLENDTHINK ENGINE DIAGNOSTIC TEST');
  console.log('='.repeat(80));
  console.log('');

  // Create engine instance
  const engine = new BlendthinkEngine({
    maxTurns: 5,
    tokenBudget: 50000,
    confidenceThreshold: 0.8,
  });

  // Show engine stats
  const stats = engine.getStats();
  console.log('Engine Configuration:');
  console.log(`  Max Turns: ${stats.config.maxTurns}`);
  console.log(`  Token Budget: ${stats.config.tokenBudget.toLocaleString()}`);
  console.log(`  Confidence Threshold: ${(stats.config.confidenceThreshold * 100)}%`);
  console.log(`  Claude Model: ${stats.config.claudeModel}`);
  console.log('');
  console.log('='.repeat(80));
  console.log('');

  for (const query of TEST_QUERIES) {
    console.log(`${'─'.repeat(80)}`);
    console.log(`QUERY: "${query}"`);
    console.log(`${'─'.repeat(80)}`);

    try {
      const diagnosis = await engine.diagnose(query);

      // Question Analysis
      console.log('\n📊 QUESTION ANALYSIS');
      console.log(`   Type: ${diagnosis.analysis.type}`);
      console.log(`   Confidence: ${(diagnosis.analysis.confidence * 100).toFixed(0)}%`);
      console.log(`   Entities: ${diagnosis.analysis.entities.join(', ') || '(none)'}`);
      if (diagnosis.analysis.operation) {
        console.log(`   Operation: ${diagnosis.analysis.operation}`);
      }
      if (diagnosis.analysis.modelHints?.length) {
        console.log(`   Model Hints: ${diagnosis.analysis.modelHints.join(', ')}`);
      }
      if (diagnosis.analysis.fieldHints?.length) {
        console.log(`   Field Hints: ${diagnosis.analysis.fieldHints.join(', ')}`);
      }

      // Route Plan
      console.log('\n🛤️  ROUTE PLAN');
      for (const step of diagnosis.routePlan.steps) {
        const depends = step.dependsOnPrevious ? ' (depends on previous)' : '';
        console.log(`   ${step.order}. ${step.section}/${step.tool}${depends}`);
        console.log(`      └─ ${step.reason}`);
      }
      if (diagnosis.routePlan.skipped.length > 0) {
        console.log('   Skipped:');
        for (const skip of diagnosis.routePlan.skipped) {
          console.log(`      ✗ ${skip.section}: ${skip.reason}`);
        }
      }
      console.log(`   Parallelizable: ${diagnosis.routePlan.canParallelize ? 'Yes' : 'No'}`);

      // Persona
      console.log('\n🎭 PERSONA');
      console.log(`   Name: ${diagnosis.persona.name}`);
      console.log(`   Style: ${diagnosis.persona.description}`);
      console.log(`   Evidence Emphasis: ${diagnosis.persona.traits.evidenceEmphasis}`);
      console.log(`   Asks Follow-ups: ${diagnosis.persona.traits.asksFollowUps ? 'Yes' : 'No'}`);
      if (diagnosis.persona.traits.claimPrefix) {
        console.log(`   Claim Prefix: "${diagnosis.persona.traits.claimPrefix}"`);
      }

      // Token Estimate
      console.log('\n💰 TOKEN ESTIMATE');
      console.log(`   Estimated: ${diagnosis.estimatedTokens.toLocaleString()} tokens`);
      const budgetPercent = (diagnosis.estimatedTokens / stats.config.tokenBudget * 100).toFixed(1);
      console.log(`   Budget Usage: ${budgetPercent}%`);

      // Warnings
      if (diagnosis.warnings.length > 0) {
        console.log('\n⚠️  WARNINGS');
        for (const warning of diagnosis.warnings) {
          console.log(`   • ${warning}`);
        }
      }

      // Clarification needed?
      if (diagnosis.analysis.needsClarification) {
        console.log('\n❓ CLARIFICATION NEEDED');
        for (const question of diagnosis.analysis.clarificationQuestions || []) {
          console.log(`   • ${question}`);
        }
      }

    } catch (error) {
      console.log(`\n❌ ERROR: ${error instanceof Error ? error.message : error}`);
    }

    console.log('');
  }

  // Session test
  console.log('='.repeat(80));
  console.log('SESSION MANAGEMENT TEST');
  console.log('='.repeat(80));
  console.log('');

  // Create a session and run multiple queries
  const result1 = await engine.analyze("Find hospital projects in Victoria");
  console.log(`Session created: ${result1.session.sessionId.substring(0, 8)}...`);
  console.log(`  Turn 1: "${result1.analysis.query.substring(0, 40)}..."`);
  console.log(`  Type: ${result1.analysis.type}`);
  console.log(`  Persona: ${result1.persona.name}`);

  // Continue same session
  const result2 = await engine.analyze(
    "What is their total revenue?",
    result1.session.sessionId
  );
  console.log(`\nContinuing session: ${result2.session.sessionId.substring(0, 8)}...`);
  console.log(`  Turn 2: "${result2.analysis.query}"`);
  console.log(`  Type: ${result2.analysis.type}`);
  console.log(`  Total turns: ${result2.session.turns.length}`);

  // Show session state
  console.log('\nSession State:');
  console.log(`  Active: ${result2.session.active}`);
  console.log(`  Persona: ${result2.session.activePersona}`);
  console.log(`  Refinement Turns Used: ${result2.session.refinementTurnsUsed}`);

  // Final stats
  const finalStats = engine.getStats();
  console.log('\nFinal Engine Stats:');
  console.log(`  Active Sessions: ${finalStats.activeSessions}`);
  console.log(`  Total Sessions: ${finalStats.totalSessions}`);

  console.log('');
  console.log('='.repeat(80));
  console.log('TEST COMPLETE');
  console.log('='.repeat(80));
}

// Run tests
runTests().catch(console.error);
