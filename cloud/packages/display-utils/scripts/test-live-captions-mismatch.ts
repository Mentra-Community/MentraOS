/**
 * Test script to debug live-captions vs glasses mirror mismatch
 *
 * Run with: cd cloud/packages/display-utils && npx tsx scripts/test-live-captions-mismatch.ts
 */

import { TextMeasurer } from "../src/measurer/TextMeasurer.js";
import { Z100_PROFILE } from "../src/profiles/z100.js";

const measurer = new TextMeasurer(Z100_PROFILE);

// What live-captions thinks fits on line 1:
const liveCaptionsLine1 = "[1]: Testing with the three little tests, you can see this is a test";

// What actually fits (from glasses mirror):
const actualLine1 = "[1]: Testing with the three little tests, y";

console.log("=== Live-Captions vs Glasses Mirror Mismatch Debug ===");
console.log();
console.log("Z100 Profile width:", Z100_PROFILE.displayWidthPx, "px");
console.log();

console.log("Live-captions line 1:");
console.log("  Text:", liveCaptionsLine1);
console.log("  Length:", liveCaptionsLine1.length, "chars");
console.log("  Width:", measurer.measureText(liveCaptionsLine1), "px");
console.log("  Fits?", measurer.measureText(liveCaptionsLine1) <= 390 ? "YES" : "NO");
console.log();

console.log("Actual line 1 (glasses mirror):");
console.log("  Text:", actualLine1);
console.log("  Length:", actualLine1.length, "chars");
console.log("  Width:", measurer.measureText(actualLine1), "px");
console.log("  Fits?", measurer.measureText(actualLine1) <= 390 ? "YES" : "NO");
console.log();

// Character by character breakdown for the difference
const diff = liveCaptionsLine1.substring(actualLine1.length);
console.log("Extra characters live-captions included:", `"${diff}"`);
console.log("Extra width:", measurer.measureText(diff), "px");
console.log();

// Show running total to find where 390px is hit
console.log("=== Character-by-character width accumulation ===");
let runningTotal = 0;
for (let i = 0; i < liveCaptionsLine1.length; i++) {
  const char = liveCaptionsLine1[i];
  const charWidth = measurer.measureChar(char);
  runningTotal += charWidth;
  const marker = runningTotal > 390 ? " <-- EXCEEDS 390px" : "";
  if (i >= actualLine1.length - 5 && i <= actualLine1.length + 5) {
    console.log(`[${i}] '${char}' = ${charWidth}px (total: ${runningTotal}px)${marker}`);
  }
}
console.log();

// Find exact break point
console.log("=== Finding exact break point ===");
for (let i = 1; i <= liveCaptionsLine1.length; i++) {
  const substr = liveCaptionsLine1.substring(0, i);
  const width = measurer.measureText(substr);
  if (width > 390) {
    console.log(`Break should happen at char ${i - 1}:`);
    console.log(
      `  Fits: "${liveCaptionsLine1.substring(0, i - 1)}" (${measurer.measureText(liveCaptionsLine1.substring(0, i - 1))}px)`,
    );
    console.log(`  Doesn't fit: "${liveCaptionsLine1.substring(0, i)}" (${width}px)`);
    break;
  }
}
