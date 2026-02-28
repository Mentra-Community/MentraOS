/**
 * Verify Z100 wrapping with the new 390px width constraint
 *
 * This script simulates real captioning scenarios to verify that text
 * wraps correctly for the Vuzix Z100 (and Mach1) glasses.
 *
 * Run with: cd cloud/packages/display-utils && npx tsx scripts/verify-z100-wrapping.ts
 */

import { TextMeasurer } from "../src/measurer/TextMeasurer.js";
import { TextWrapper } from "../src/wrapper/TextWrapper.js";
import { Z100_PROFILE } from "../src/profiles/z100.js";

const measurer = new TextMeasurer(Z100_PROFILE);
const wrapper = new TextWrapper(measurer, {
  breakMode: "character-no-hyphen",
  hyphenChar: "-",
  minCharsBeforeHyphen: 3,
});

console.log("=== Z100 Wrapping Verification ===");
console.log(`Profile: ${Z100_PROFILE.name}`);
console.log(`Display Width: ${Z100_PROFILE.displayWidthPx}px`);
console.log(`Max Lines: ${Z100_PROFILE.maxLines}`);
console.log();

// Test scenarios that represent real captioning use cases
const testScenarios = [
  {
    name: "Short sentence",
    text: "Hello, how are you doing today?",
  },
  {
    name: "Medium sentence with speaker label",
    text: "[1]: I'm doing great, thanks for asking. How about you?",
  },
  {
    name: "Long sentence that should wrap",
    text: "The quick brown fox jumps over the lazy dog and runs through the forest.",
  },
  {
    name: "Technical content",
    text: "[2]: We need to update the configuration file and restart the server.",
  },
  {
    name: "Multi-speaker conversation",
    text: "[1]: Hello there!\n[2]: Hi! Nice to meet you. How's your day going?",
  },
  {
    name: "Numbers and punctuation",
    text: "The meeting is scheduled for 3:30 PM on December 15th, 2024.",
  },
  {
    name: "Long word that needs breaking",
    text: "The word supercalifragilisticexpialidocious is very long.",
  },
  {
    name: "Real captioning scenario - medical",
    text: "[Doctor]: Your blood pressure is 120 over 80, which is normal. Let's discuss your medications.",
  },
  {
    name: "Real captioning scenario - classroom",
    text: "[Teacher]: Today we'll be learning about photosynthesis. Can anyone tell me what that means?",
  },
];

for (const scenario of testScenarios) {
  console.log(`--- ${scenario.name} ---`);
  console.log(`Input: "${scenario.text}"`);
  console.log(`Input length: ${scenario.text.length} chars`);
  console.log();

  const result = wrapper.wrap(scenario.text, {
    maxWidthPx: Z100_PROFILE.displayWidthPx,
    maxLines: Z100_PROFILE.maxLines,
    maxBytes: Infinity,
  });

  console.log(`Lines (${result.lines.length}):`);
  result.lines.forEach((line, i) => {
    const lineWidth = measurer.measureText(line);
    const utilization = ((lineWidth / Z100_PROFILE.displayWidthPx) * 100).toFixed(1);
    console.log(`  ${i + 1}. "${line}"`);
    console.log(`     Width: ${lineWidth}px / ${Z100_PROFILE.displayWidthPx}px (${utilization}%)`);
  });

  if (result.truncated) {
    console.log(`  ⚠️  Text was truncated (exceeded ${Z100_PROFILE.maxLines} lines)`);
  }

  console.log();
}

// Verify edge cases
console.log("=== Edge Case Verification ===");
console.log();

// Test exact fit
const exactFitText = "[1]: Testing testing 1-2-3 testing testing";
const exactFitWidth = measurer.measureText(exactFitText);
console.log(`Exact fit test: "${exactFitText}"`);
console.log(`Width: ${exactFitWidth}px (should be ~387px, just under 390px)`);
console.log(`Fits: ${exactFitWidth <= Z100_PROFILE.displayWidthPx ? "✅ Yes" : "❌ No"}`);
console.log();

// Test one char over
const overflowText = exactFitText + " x";
const overflowWidth = measurer.measureText(overflowText);
console.log(`Overflow test: "${overflowText}"`);
console.log(`Width: ${overflowWidth}px (should exceed 390px)`);
console.log(`Fits: ${overflowWidth <= Z100_PROFILE.displayWidthPx ? "✅ Yes" : "❌ No (expected)"}`);

const overflowResult = wrapper.wrap(overflowText, {
  maxWidthPx: Z100_PROFILE.displayWidthPx,
  maxLines: Z100_PROFILE.maxLines,
  maxBytes: Infinity,
});
console.log(`Wraps to ${overflowResult.lines.length} lines:`);
overflowResult.lines.forEach((line, i) => {
  console.log(`  ${i + 1}. "${line}"`);
});
console.log();

console.log("=== Summary ===");
console.log();
console.log("If the above output looks correct:");
console.log("1. Lines should not exceed ~390px");
console.log("2. Text should break cleanly without hyphens (character-no-hyphen mode)");
console.log("3. Speaker labels [N]: should stay on the same line as the start of their text");
console.log("4. Long words should break mid-word without adding hyphens");
console.log();
console.log("The Z100/Mach1 profile is ready for testing on actual devices!");
