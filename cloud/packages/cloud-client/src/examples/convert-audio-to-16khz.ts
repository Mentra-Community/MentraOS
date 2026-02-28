import * as fs from "fs";
import { execSync } from "child_process";
import { resolve } from "path";

// Convert a WAV file to 16kHz mono using ffmpeg
function convertTo16kHzMono(inputPath: string, outputPath: string) {
  try {
    // Use ffmpeg to convert to 16kHz mono
    const command = `ffmpeg -i "${inputPath}" -ar 16000 -ac 1 -y "${outputPath}"`;
    console.log("Converting:", inputPath);
    console.log("Command:", command);

    execSync(command, { stdio: "pipe" });
    console.log("✅ Converted to:", outputPath);

    // Verify the output
    const stats = fs.statSync(outputPath);
    console.log("   Output size:", (stats.size / 1024).toFixed(1), "KB");

    // Check format
    const info = execSync(`file "${outputPath}"`, { encoding: "utf-8" });
    console.log("   Format:", info.trim());
  } catch (error) {
    console.error("❌ Conversion failed:", error.message);
    console.log("Make sure ffmpeg is installed: brew install ffmpeg");
  }
}

// Convert test audio files
const audioDir = resolve(__dirname, "../audio");
const testFiles = ["what-time-is-it.wav", "hey-mira.wav", "short-test.wav"];

console.log("🎵 Converting audio files to 16kHz mono for testing\n");

for (const file of testFiles) {
  const inputPath = resolve(audioDir, file);
  const outputPath = resolve(audioDir, file.replace(".wav", "-16khz.wav"));

  if (fs.existsSync(inputPath)) {
    convertTo16kHzMono(inputPath, outputPath);
  } else {
    console.log("⚠️  File not found:", inputPath);
  }
  console.log();
}

console.log("✅ Conversion complete!");
console.log("Use the -16khz.wav files for testing with LiveKit");
