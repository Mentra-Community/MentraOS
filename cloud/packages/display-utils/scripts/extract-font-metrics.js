#!/usr/bin/env node

/**
 * Font Metrics Extraction Script
 *
 * Extracts glyph widths from TTF font files for use in display profiles.
 * Outputs a TypeScript-compatible object with character -> width mappings.
 *
 * Usage:
 *   node extract-font-metrics.js <font.ttf> [fontSize] [outputFormat]
 *
 * Examples:
 *   node extract-font-metrics.js NotoSans-Regular.ttf 21 ts
 *   node extract-font-metrics.js NotoSans-Regular.ttf 21 json
 *
 * Requirements:
 *   npm install opentype.js
 */

const opentype = require("opentype.js");
const fs = require("fs");
const path = require("path");

// Characters to extract - covers ASCII printable range plus common punctuation
const CHARS_TO_EXTRACT = [
  // Space and punctuation
  " ",
  "!",
  '"',
  "#",
  "$",
  "%",
  "&",
  "'",
  "(",
  ")",
  "*",
  "+",
  ",",
  "-",
  ".",
  "/",
  // Numbers
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  // More punctuation
  ":",
  ";",
  "<",
  "=",
  ">",
  "?",
  "@",
  // Uppercase letters
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
  // Brackets and special
  "[",
  "\\",
  "]",
  "^",
  "_",
  "`",
  // Lowercase letters
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  // More special
  "{",
  "|",
  "}",
  "~",
];

/**
 * Extract glyph widths from a font file
 * @param {string} fontPath - Path to the TTF/OTF font file
 * @param {number} fontSize - Font size to calculate widths at
 * @returns {Object} Character to width mapping
 */
function extractGlyphWidths(fontPath, fontSize = 21) {
  const font = opentype.loadSync(fontPath);
  const glyphWidths = {};

  // Get the scale factor for converting font units to pixels
  const scale = fontSize / font.unitsPerEm;

  console.log(`\nFont: ${font.names.fullName?.en || fontPath}`);
  console.log(`Units per Em: ${font.unitsPerEm}`);
  console.log(`Font size: ${fontSize}px`);
  console.log(`Scale factor: ${scale.toFixed(6)}`);
  console.log("");

  for (const char of CHARS_TO_EXTRACT) {
    const glyph = font.charToGlyph(char);
    if (glyph && glyph.advanceWidth !== undefined) {
      // Convert advance width from font units to pixels
      const widthPx = Math.round(glyph.advanceWidth * scale);
      glyphWidths[char] = widthPx;
    } else {
      // Use a default width if glyph not found
      console.warn(`Warning: Glyph not found for '${char}' (0x${char.charCodeAt(0).toString(16)})`);
      glyphWidths[char] = Math.round(fontSize * 0.5); // Default to half font size
    }
  }

  return glyphWidths;
}

/**
 * Format glyph widths as TypeScript object
 */
function formatAsTypeScript(glyphWidths, profileName = "PROFILE") {
  let output = `const ${profileName}_GLYPH_WIDTHS: Record<string, number> = {\n`;

  // Group by category for readability
  const categories = [
    {
      name: "Space and punctuation",
      chars: [" ", "!", '"', "#", "$", "%", "&", "'", "(", ")", "*", "+", ",", "-", ".", "/"],
    },
    { name: "Numbers", chars: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] },
    { name: "More punctuation", chars: [":", ";", "<", "=", ">", "?", "@"] },
    { name: "Uppercase", chars: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("") },
    { name: "Brackets & special", chars: ["[", "\\", "]", "^", "_", "`"] },
    { name: "Lowercase", chars: "abcdefghijklmnopqrstuvwxyz".split("") },
    { name: "More special", chars: ["{", "|", "}", "~"] },
  ];

  for (const category of categories) {
    output += `  // ${category.name}\n`;
    for (const char of category.chars) {
      const width = glyphWidths[char];
      const charDisplay = char === "\\" ? "\\\\" : char === "'" ? "\\'" : char;
      output += `  "${charDisplay}": ${width},\n`;
    }
    output += "\n";
  }

  output += "};\n";
  return output;
}

/**
 * Format glyph widths as JSON
 */
function formatAsJSON(glyphWidths) {
  return JSON.stringify(glyphWidths, null, 2);
}

/**
 * Calculate statistics about the widths
 */
function calculateStats(glyphWidths) {
  const widths = Object.values(glyphWidths);
  const min = Math.min(...widths);
  const max = Math.max(...widths);
  const avg = widths.reduce((a, b) => a + b, 0) / widths.length;

  return { min, max, avg: Math.round(avg * 100) / 100, count: widths.length };
}

// Main execution
function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log("Usage: node extract-font-metrics.js <font.ttf> [fontSize] [outputFormat]");
    console.log("");
    console.log("Arguments:");
    console.log("  font.ttf      Path to the TTF/OTF font file");
    console.log("  fontSize      Font size in pixels (default: 21)");
    console.log('  outputFormat  Output format: "ts" or "json" (default: ts)');
    console.log("");
    console.log("Examples:");
    console.log("  node extract-font-metrics.js NotoSans-Regular.ttf");
    console.log("  node extract-font-metrics.js NotoSans-Regular.ttf 21 json");
    process.exit(1);
  }

  const fontPath = args[0];
  const fontSize = parseInt(args[1]) || 21;
  const outputFormat = args[2] || "ts";

  if (!fs.existsSync(fontPath)) {
    console.error(`Error: Font file not found: ${fontPath}`);
    process.exit(1);
  }

  console.log("Extracting font metrics...");
  const glyphWidths = extractGlyphWidths(fontPath, fontSize);

  const stats = calculateStats(glyphWidths);
  console.log("Statistics:");
  console.log(`  Characters: ${stats.count}`);
  console.log(`  Min width: ${stats.min}px`);
  console.log(`  Max width: ${stats.max}px`);
  console.log(`  Avg width: ${stats.avg}px`);
  console.log("");

  // Generate profile name from font filename
  const fontName = path
    .basename(fontPath, path.extname(fontPath))
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_");

  let output;
  if (outputFormat === "json") {
    output = formatAsJSON(glyphWidths);
    console.log("JSON output:");
  } else {
    output = formatAsTypeScript(glyphWidths, fontName);
    console.log("TypeScript output:");
  }

  console.log("");
  console.log(output);

  // Also write to file
  const outputFile = fontPath.replace(/\.(ttf|otf)$/i, `.${outputFormat === "json" ? "json" : "ts"}`);
  fs.writeFileSync(outputFile, output);
  console.log(`\nWritten to: ${outputFile}`);
}

main();
