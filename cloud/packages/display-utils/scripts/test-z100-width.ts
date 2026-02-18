/**
 * Test script to measure Z100 text width
 *
 * Run with: cd cloud/packages/display-utils && npx tsx scripts/test-z100-width.ts
 */

import { TextMeasurer } from "../src/measurer/TextMeasurer.js";
import { Z100_PROFILE } from "../src/profiles/z100.js";

const measurer = new TextMeasurer(Z100_PROFILE);

console.log("=== Z100 Text Width Test ===\n");

// The test text that fits on one line on actual Z100
const testText = "[1]: Testing testing 1-2-3 testing testing";
const width = measurer.measureText(testText);

console.log(`Test text: "${testText}"`);
console.log(`Length: ${testText.length} chars`);
console.log(`Measured width: ${width}px`);
console.log(`Profile display width: ${Z100_PROFILE.displayWidthPx}px`);
console.log(`Fits on one line (our calc): ${width <= Z100_PROFILE.displayWidthPx}`);
console.log();

// If this wraps on actual device but our calc says it fits,
// then our displayWidthPx is too high
if (width <= Z100_PROFILE.displayWidthPx) {
  console.log("⚠️  Our calculation says this fits, but if it wraps on device,");
  console.log(`   the real display width is probably around ${width}px or less`);
}

console.log();
console.log("=== Character-by-character breakdown ===\n");

let runningTotal = 0;
for (const char of testText) {
  const charWidth = measurer.measureChar(char);
  runningTotal += charWidth;
  console.log(`'${char}' = ${charWidth}px (total: ${runningTotal}px)`);
}

console.log();
console.log("=== Testing different lengths ===\n");

const testStrings = [
  "[1]: Testing testing 1-2-3",
  "[1]: Testing testing 1-2-3 testing",
  "[1]: Testing testing 1-2-3 testing testing",
  "[1]: Testing testing 1-2-3 testing testing test",
];

for (const str of testStrings) {
  const w = measurer.measureText(str);
  const fits = w <= Z100_PROFILE.displayWidthPx;
  console.log(`${fits ? "✅" : "❌"} ${w}px (${str.length} chars): "${str}"`);
}

console.log();
console.log("=== Suggested fix ===\n");
console.log(`If "${testText}" is the MAX that fits on one line,`);
console.log(`then Z100_PROFILE.displayWidthPx should be ~${width}px (currently ${Z100_PROFILE.displayWidthPx}px)`);
