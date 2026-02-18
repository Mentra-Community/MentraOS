/**
 * Test user-provided strings against Z100 profile
 *
 * Run with: cd cloud/packages/display-utils && npx tsx scripts/test-user-strings.ts
 */

import { TextMeasurer } from "../src/measurer/TextMeasurer.js";
import { Z100_PROFILE } from "../src/profiles/z100.js";

const measurer = new TextMeasurer(Z100_PROFILE);

const test1 = "[1]: ABCDEFG. We like testing 1, 2, 3.";
const test2 = "[1]: Testing 1, testing 2, testing 3, test.";

console.log("=== Z100 User String Test ===");
console.log();
console.log("Z100 Profile width:", Z100_PROFILE.displayWidthPx, "px");
console.log();

console.log("Test 1:", test1);
console.log("  Length:", test1.length, "chars");
console.log("  Width:", measurer.measureText(test1), "px");
console.log("  Fits:", measurer.measureText(test1) <= Z100_PROFILE.displayWidthPx ? "✅ YES" : "❌ NO");
console.log();

console.log("Test 2:", test2);
console.log("  Length:", test2.length, "chars");
console.log("  Width:", measurer.measureText(test2), "px");
console.log("  Fits:", measurer.measureText(test2) <= Z100_PROFILE.displayWidthPx ? "✅ YES" : "❌ NO");
console.log();

// Reference: our known max that fits
const reference = "[1]: Testing testing 1-2-3 testing testing";
console.log("Reference (known max):", reference);
console.log("  Length:", reference.length, "chars");
console.log("  Width:", measurer.measureText(reference), "px");
console.log("  Fits:", measurer.measureText(reference) <= Z100_PROFILE.displayWidthPx ? "✅ YES" : "❌ NO");
