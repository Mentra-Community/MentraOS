/**
 * Column Alignment Test Script
 *
 * Tests the ColumnComposer's pixel alignment for double_text_wall layouts.
 * Verifies that the right column always starts at the correct pixel position.
 *
 * Usage:
 *   cd cloud/packages/display-utils
 *   npx tsx scripts/test-column-alignment.ts
 *
 * @see Issue 026b: Double Text Wall Alignment Investigation
 */

import { ColumnComposer } from "../src/composer/ColumnComposer.js";
import { G1_PROFILE } from "../src/profiles/g1.js";
import { TextMeasurer } from "../src/measurer/TextMeasurer.js";

// =============================================================================
// Setup
// =============================================================================

const composer = new ColumnComposer(G1_PROFILE, "character-no-hyphen");
const measurer = new TextMeasurer(G1_PROFILE);
const config = composer.getDefaultColumnConfig();

console.log("╔══════════════════════════════════════════════════════════════════╗");
console.log("║           Column Alignment Test - double_text_wall               ║");
console.log("╚══════════════════════════════════════════════════════════════════╝");
console.log();

// =============================================================================
// Configuration Output
// =============================================================================

console.log("=== G1 Profile Configuration ===");
console.log(`Display width:      ${G1_PROFILE.displayWidthPx}px`);
console.log(`Max lines:          ${G1_PROFILE.maxLines}`);
console.log(`Space width:        ${measurer.measureText(" ")}px`);
console.log();

console.log("=== Column Layout ===");
console.log(
  `Left column width:  ${config.leftColumnWidthPx}px (${Math.round((config.leftColumnWidthPx / G1_PROFILE.displayWidthPx) * 100)}%)`,
);
console.log(
  `Right column start: ${config.rightColumnStartPx}px (${Math.round((config.rightColumnStartPx / G1_PROFILE.displayWidthPx) * 100)}%)`,
);
console.log(
  `Right column width: ${config.rightColumnWidthPx}px (${Math.round((config.rightColumnWidthPx / G1_PROFILE.displayWidthPx) * 100)}%)`,
);
console.log(`Gap between:        ${config.rightColumnStartPx - config.leftColumnWidthPx}px`);
console.log();

// =============================================================================
// Test Cases
// =============================================================================

interface TestCase {
  name: string;
  description: string;
  leftText: string;
  rightText: string;
}

const testCases: TestCase[] = [
  {
    name: "Simple Dashboard",
    description: "Basic time/battery + status",
    leftText: "1:30 PM, 85%",
    rightText: "Meeting @ 2pm",
  },
  {
    name: "With Notification",
    description: "Left has notification, right has status + weather",
    leftText: "1:30 PM, 85%\nJohn: Hey are you free?",
    rightText: "Meeting @ 2pm\nWeather: 72°F Sunny",
  },
  {
    name: "Long Right Content",
    description: "Tests wrapping in right column",
    leftText: "1:30 PM, 85%\nNew message",
    rightText: "Meeting @ 2pm\nWeather: 72°F Sunny with clear skies expected throughout the afternoon and evening",
  },
  {
    name: "Both Columns Long",
    description: "Both columns need wrapping",
    leftText: "1:30 PM, 85%\nJohn sent you a very long message that needs to wrap across lines\nMeeting reminder",
    rightText: "Team standup in 15 minutes\nWeather: 72°F Sunny\nCalendar: 3 events today",
  },
  {
    name: "Empty Left",
    description: "Only right column has content",
    leftText: "",
    rightText: "All content on the right side\nThis tests alignment when left is empty",
  },
  {
    name: "Empty Right",
    description: "Only left column has content",
    leftText: "All content on the left side\nThis tests alignment when right is empty",
    rightText: "",
  },
  {
    name: "Narrow Characters",
    description: "Tests with narrow characters (i, l, 1)",
    leftText: "iiiiiiiiiiiiiiiii\nlllllllllllllllll",
    rightText: "111111111111111\niiiiiiiiiiiiii",
  },
  {
    name: "Wide Characters",
    description: "Tests with wide characters (m, w, W)",
    leftText: "mmmmmmmm\nwwwwwwww",
    rightText: "WWWWWWWW\nmmmmmmmm",
  },
  {
    name: "Mixed Width",
    description: "Mix of narrow and wide characters",
    leftText: "iiiWWWiii\nlllMMMlll",
    rightText: "WiWiWiWi\nMlMlMlMl",
  },
];

// =============================================================================
// Run Tests
// =============================================================================

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const spaceWidth = measurer.measureText(" ");
const tolerance = spaceWidth; // Allow up to 1 space width of error

for (const testCase of testCases) {
  console.log("═".repeat(70));
  console.log(`TEST: ${testCase.name}`);
  console.log(`Description: ${testCase.description}`);
  console.log("─".repeat(70));

  const result = composer.composeDoubleTextWall(testCase.leftText, testCase.rightText);

  console.log("Left column lines:");
  result.leftLines.forEach((line, i) => {
    const width = measurer.measureText(line);
    console.log(`  [${i}] "${line}" (${width}px)`);
  });

  console.log("\nRight column lines:");
  result.rightLines.forEach((line, i) => {
    const width = measurer.measureText(line);
    console.log(`  [${i}] "${line}" (${width}px)`);
  });

  console.log("\nAlignment Analysis:");

  const composedLines = result.composedText.split("\n");
  let testPassed = true;

  for (let i = 0; i < composedLines.length; i++) {
    totalTests++;
    const line = composedLines[i];
    const leftText = result.leftLines[i] || "";
    const rightText = result.rightLines[i] || "";

    // Calculate actual right column start position
    const leftWidth = measurer.measureText(leftText);

    // Count spaces between left and right content
    let spaceCount = 0;
    if (leftText.length < line.length) {
      const afterLeft = line.substring(leftText.length);
      for (const char of afterLeft) {
        if (char === " ") {
          spaceCount++;
        } else {
          break;
        }
      }
    }

    const actualRightStart = leftWidth + spaceCount * spaceWidth;
    const expectedRightStart = config.rightColumnStartPx;
    const error = actualRightStart - expectedRightStart;
    const absError = Math.abs(error);

    const status = absError <= tolerance ? "✅" : "❌";
    if (absError > tolerance) {
      testPassed = false;
      failedTests++;
    } else {
      passedTests++;
    }

    console.log(`  Line ${i}: ${status}`);
    console.log(`    Left: "${leftText}" (${leftWidth}px)`);
    console.log(`    Spaces: ${spaceCount} (${spaceCount * spaceWidth}px)`);
    console.log(`    Right: "${rightText}"`);
    console.log(`    Expected start: ${expectedRightStart}px`);
    console.log(`    Actual start:   ${actualRightStart}px`);
    console.log(`    Error:          ${error >= 0 ? "+" : ""}${error}px ${absError <= tolerance ? "(OK)" : "(FAIL!)"}`);
  }

  console.log();
  console.log(`Result: ${testPassed ? "✅ PASSED" : "❌ FAILED"}`);
  console.log();
}

// =============================================================================
// Summary
// =============================================================================

console.log("═".repeat(70));
console.log("SUMMARY");
console.log("═".repeat(70));
console.log(`Total line tests: ${totalTests}`);
console.log(`Passed:           ${passedTests} (${Math.round((passedTests / totalTests) * 100)}%)`);
console.log(`Failed:           ${failedTests} (${Math.round((failedTests / totalTests) * 100)}%)`);
console.log(`Tolerance:        ±${tolerance}px (1 space width)`);
console.log();

if (failedTests === 0) {
  console.log("🎉 All alignment tests passed!");
} else {
  console.log("⚠️  Some alignment tests failed. Review the errors above.");
}

// =============================================================================
// Visual Example
// =============================================================================

console.log();
console.log("═".repeat(70));
console.log("VISUAL EXAMPLE (Simple Dashboard)");
console.log("═".repeat(70));

const exampleResult = composer.composeDoubleTextWall(
  "1:30 PM, 85%\nNotification text",
  "Meeting @ 2pm\nWeather: 72°F Sunny with clouds",
);

console.log("\nComposed output (what gets sent to glasses):");
console.log("─".repeat(70));
const exampleLines = exampleResult.composedText.split("\n");
exampleLines.forEach((line, i) => {
  console.log(`Line ${i}: "${line}"`);
});
console.log("─".repeat(70));

console.log("\nVisual representation (L=left, .=gap, R=right):");
const visualScale = 10; // 1 char = ~10px
const displayChars = Math.ceil(G1_PROFILE.displayWidthPx / visualScale);
const rightStartChar = Math.ceil(config.rightColumnStartPx / visualScale);

console.log(
  "       " +
    "0".padStart(1) +
    " ".repeat(rightStartChar - 2) +
    "|" +
    " ".repeat(displayChars - rightStartChar - 1) +
    `${G1_PROFILE.displayWidthPx}px`,
);
console.log(
  "       " + "│" + " ".repeat(rightStartChar - 2) + "│" + " ".repeat(displayChars - rightStartChar - 1) + "│",
);

exampleLines.forEach((line, i) => {
  const leftText = exampleResult.leftLines[i] || "";
  const rightText = exampleResult.rightLines[i] || "";
  const leftWidth = measurer.measureText(leftText);
  const rightWidth = measurer.measureText(rightText);

  const leftChars = Math.ceil(leftWidth / visualScale);
  const rightChars = Math.ceil(rightWidth / visualScale);

  let visual = "";
  for (let p = 0; p < displayChars; p++) {
    if (p < leftChars) {
      visual += "L";
    } else if (p < rightStartChar) {
      visual += ".";
    } else if (p < rightStartChar + rightChars) {
      visual += "R";
    } else {
      visual += " ";
    }
  }
  console.log(`Line ${i}: │${visual}│`);
});

console.log();
console.log("Legend: L = Left column content, . = Gap (spaces), R = Right column content");
console.log(`        │ at position 0 and ${config.rightColumnStartPx}px marks column boundaries`);
