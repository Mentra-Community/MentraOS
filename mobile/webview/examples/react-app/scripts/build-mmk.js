#!/usr/bin/env node

import {execSync} from "child_process"
import fs from "fs"
import path from "path"
import {fileURLToPath} from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT_DIR = path.join(__dirname, "..")

const DIST_DIR = path.join(ROOT_DIR, "dist")
const APP_JSON = path.join(ROOT_DIR, "assets", "app.json")
const ICON_PNG = path.join(ROOT_DIR, "assets", "icon.png")
const OUTPUT_DIR = path.join(ROOT_DIR, "build")

console.log("📦 Building MentraOS Mini App Package...\n")

// Step 1: Build the Vite app
console.log("Building Vite app...")
try {
  execSync("vite build", {stdio: "inherit"})
  console.log("✅ Vite build complete\n")
} catch (error) {
  console.error("❌ Vite build failed")
  process.exit(1)
}

// Step 2: Copy app.json and icon.png to dist
console.log("Copying app.json and icon.png to dist...")
try {
  if (!fs.existsSync(APP_JSON)) {
    console.error("❌ app.json not found")
    process.exit(1)
  }
  if (!fs.existsSync(ICON_PNG)) {
    console.error("❌ icon.png not found")
    process.exit(1)
  }

  fs.copyFileSync(APP_JSON, path.join(DIST_DIR, "app.json"))
  fs.copyFileSync(ICON_PNG, path.join(DIST_DIR, "icon.png"))
  console.log("✅ Files copied\n")
} catch (error) {
  console.error("❌ Failed to copy files:", error.message)
  process.exit(1)
}

// Step 3: Read app.json to get package name
console.log("3️⃣  Reading package metadata...")
let packageName = "app"
try {
  const appJson = JSON.parse(fs.readFileSync(APP_JSON, "utf8"))
  packageName = appJson.packageName || appJson.name || "app"
  console.log(`   Package name: ${packageName}`)
  console.log("✅ Metadata read\n")
} catch (error) {
  console.error("⚠️  Failed to read app.json, using default name")
}

// Step 4: Create build directory
console.log("4️⃣  Creating build directory...")
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, {recursive: true})
}
console.log("✅ Build directory ready\n")

// Step 5: Create zip file (MMK package)
const zipName = `${packageName}.zip`
const zipPath = path.join(OUTPUT_DIR, zipName)

console.log("5️⃣  Creating .zip package...")
try {
  // Remove existing zip if it exists
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath)
  }

  // Use zip command to create the package
  // -r for recursive, -q for quiet, -j to junk paths (store files in root of zip)
  execSync(`cd ${DIST_DIR} && zip -r -q ${zipPath} .`, {stdio: "inherit"})

  console.log(`✅ Package created: ${zipPath}\n`)
} catch (error) {
  console.error("❌ Failed to create package:", error.message)
  process.exit(1)
}

// Step 6: Show package info
console.log("📊 Package Information:")
const stats = fs.statSync(zipPath)
console.log(`   File: ${zipName}`)
console.log(`   Size: ${(stats.size / 1024).toFixed(2)} KB`)
console.log(`   Path: ${zipPath}`)

console.log("\n✨ Build complete!")
