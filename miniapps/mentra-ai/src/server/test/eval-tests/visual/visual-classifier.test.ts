/**
 * Eval: Visual Query Classifier
 *
 * Evaluates isVisualQuery() LLM classifier against JSON fixture datasets.
 * Four sets: easy, medium, hard, realistic.
 * Makes REAL Gemini Flash API calls — requires GOOGLE_GENERATIVE_AI_API_KEY in .env.
 *
 * Fixtures: src/server/test/visual/fixtures/visual-classifier-{easy,medium,hard,realistic}.json
 *
 * Run all:         bun test:visual
 * Run one:         bun test:visual:easy / medium / hard / realistic
 */

import { describe, test, afterAll } from "bun:test";
import { isVisualQuery } from "../../../agent/visual-classifier";
import easyCases from "./fixtures/visual-classifier-easy.json";
import mediumCases from "./fixtures/visual-classifier-medium.json";
import hardCases from "./fixtures/visual-classifier-hard.json";
import realisticCases from "./fixtures/visual-classifier-realistic.json";

interface EvalCase {
  query: string;
  expected: boolean;
  category: string;
  note?: string;
}

interface EvalResult {
  query: string;
  expected: boolean;
  actual: boolean;
  pass: boolean;
  category: string;
  ms: number;
  difficulty: string;
}

const allResults: EvalResult[] = [];

// Support both CLI arg and env var: `bun test ... easy` or `EVAL_DIFFICULTY=easy bun test ...`
const cliArg = process.argv.find(a => ["easy", "medium", "hard", "realistic"].includes(a.toLowerCase()));
const difficulty = (cliArg || process.env.EVAL_DIFFICULTY)?.toLowerCase();
const datasets: { name: string; cases: EvalCase[] }[] = [];

if (!difficulty || difficulty === "easy") datasets.push({ name: "easy", cases: easyCases.cases as EvalCase[] });
if (!difficulty || difficulty === "medium") datasets.push({ name: "medium", cases: mediumCases.cases as EvalCase[] });
if (!difficulty || difficulty === "hard") datasets.push({ name: "hard", cases: hardCases.cases as EvalCase[] });
if (!difficulty || difficulty === "realistic") datasets.push({ name: "realistic", cases: realisticCases.cases as EvalCase[] });

for (const dataset of datasets) {
  describe(`isVisualQuery — ${dataset.name} (${dataset.cases.length} cases)`, () => {
    for (const c of dataset.cases) {
      test(`[${c.category}] "${c.query}" — expected: ${c.expected ? "visual" : "non-visual"}`, async () => {
        const start = Date.now();
        const actual = await isVisualQuery(c.query);
        const ms = Date.now() - start;
        const pass = actual === c.expected;
        allResults.push({ query: c.query, expected: c.expected, actual, pass, category: c.category, ms, difficulty: dataset.name });

        if (!pass) {
          // Throw a clean error without bun's stack trace spam
          throw new Error(
            `MISMATCH: "${c.query}" — expected ${c.expected ? "visual" : "non-visual"}, got ${actual ? "visual" : "non-visual"}`
          );
        }
      }, 10000);
    }
  });
}

afterAll(() => {
  if (allResults.length === 0) return;

  const passed = allResults.filter(r => r.pass).length;
  const failed = allResults.filter(r => !r.pass);
  const times = allResults.map(r => r.ms).sort((a, b) => a - b);
  const totalMs = times.reduce((sum, t) => sum + t, 0);
  const avgMs = Math.round(totalMs / times.length);
  const medianMs = times[Math.floor(times.length / 2)];
  const minMs = times[0];
  const maxMs = times[times.length - 1];
  const slowest = allResults.reduce((a, b) => a.ms > b.ms ? a : b);
  const fastest = allResults.reduce((a, b) => a.ms < b.ms ? a : b);

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  VISUAL CLASSIFIER EVAL REPORT`);
  console.log(`${"=".repeat(70)}`);

  // Overall
  console.log(`\n  Score:    ${passed}/${allResults.length} passed (${Math.round(passed / allResults.length * 100)}%)`);
  console.log(`  Total:    ${(totalMs / 1000).toFixed(1)}s`);

  // Timing
  console.log(`\n  Timing:`);
  console.log(`    avg:     ${avgMs}ms`);
  console.log(`    median:  ${medianMs}ms`);
  console.log(`    min:     ${minMs}ms  ("${fastest.query.slice(0, 40)}${fastest.query.length > 40 ? '...' : ''}")`);
  console.log(`    max:     ${maxMs}ms  ("${slowest.query.slice(0, 40)}${slowest.query.length > 40 ? '...' : ''}")`);

  // By difficulty
  const difficulties = [...new Set(allResults.map(r => r.difficulty))];
  console.log(`\n  By difficulty:`);
  for (const d of difficulties) {
    const dResults = allResults.filter(r => r.difficulty === d);
    const dPassed = dResults.filter(r => r.pass).length;
    const dAvg = Math.round(dResults.reduce((s, r) => s + r.ms, 0) / dResults.length);
    const marker = dPassed === dResults.length ? "✅" : "⚠️";
    console.log(`    ${marker} ${d.padEnd(12)} ${dPassed}/${dResults.length} (${String(Math.round(dPassed / dResults.length * 100)).padStart(3)}%)  avg ${dAvg}ms`);
  }

  // By category
  const categories = [...new Set(allResults.map(r => r.category))];
  console.log(`\n  By category:`);
  for (const cat of categories) {
    const catResults = allResults.filter(r => r.category === cat);
    const catPassed = catResults.filter(r => r.pass).length;
    const marker = catPassed === catResults.length ? "✅" : "⚠️";
    console.log(`    ${marker} ${cat.padEnd(24)} ${catPassed}/${catResults.length}`);
  }

  // Failed cases
  if (failed.length > 0) {
    console.log(`\n  Failed (${failed.length}):`);
    for (const f of failed) {
      console.log(`    [${f.difficulty}/${f.category}] "${f.query.slice(0, 50)}${f.query.length > 50 ? '...' : ''}"`);
      console.log(`      expected ${f.expected ? "visual" : "non-visual"}, got ${f.actual ? "visual" : "non-visual"} (${f.ms}ms)`);
    }
  }

  console.log(`\n${"=".repeat(70)}\n`);
});
