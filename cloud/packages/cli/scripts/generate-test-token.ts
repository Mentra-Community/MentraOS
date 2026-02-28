#!/usr/bin/env bun
/**
 * Generate Test CLI Token
 *
 * Creates a test JWT token for local CLI testing without needing the console UI.
 * This is only for development - in production, tokens are generated via console.
 */

import jwt from "jsonwebtoken"
import crypto from "crypto"
import {v4 as uuidv4} from "uuid"

const CLI_JWT_SECRET =
  process.env.CLI_AUTH_JWT_SECRET || process.env.CONSOLE_AUTH_JWT_SECRET || process.env.AUGMENTOS_AUTH_JWT_SECRET || ""

if (!CLI_JWT_SECRET) {
  console.error("❌ Error: No JWT secret found")
  console.error("   Set one of:")
  console.error("   - CLI_AUTH_JWT_SECRET")
  console.error("   - CONSOLE_AUTH_JWT_SECRET")
  console.error("   - AUGMENTOS_AUTH_JWT_SECRET")
  process.exit(1)
}

// Get email from command line argument or use default
const email = process.argv[2] || "test@example.com"
const keyName = process.argv[3] || "Test Key"
const expiresInDays = parseInt(process.argv[4] || "365")

// Generate token
const keyId = uuidv4()
const now = Math.floor(Date.now() / 1000)
const exp = now + expiresInDays * 24 * 60 * 60

const payload = {
  email,
  type: "cli",
  keyId,
  name: keyName,
  iat: now,
  exp,
}

const token = jwt.sign(payload, CLI_JWT_SECRET)
const hashedToken = crypto.createHash("sha256").update(token).digest("hex")

console.log("✅ Test CLI Token Generated")
console.log("")
console.log("📋 Token Details:")
console.log(`   Email:      ${email}`)
console.log(`   Key Name:   ${keyName}`)
console.log(`   Key ID:     ${keyId}`)
console.log(`   Expires:    ${new Date(exp * 1000).toLocaleString()}`)
console.log("")
console.log("🔑 JWT Token (use this with 'mentra auth'):")
console.log(token)
console.log("")
console.log("🔒 Hashed Token (store this in DB):")
console.log(hashedToken)
console.log("")
console.log("💾 MongoDB Insert Command:")
console.log(`db.clikeys.insertOne({
  keyId: "${keyId}",
  userId: ObjectId("<your-user-id>"),
  email: "${email}",
  name: "${keyName}",
  hashedToken: "${hashedToken}",
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date()
})`)
console.log("")
console.log("🚀 Usage:")
console.log(`   mentra auth ${token}`)
console.log("")
console.log("ℹ️  Note: You must insert the hashed token into your database")
console.log("   for the token to work. The CLI will verify it on each request.")
