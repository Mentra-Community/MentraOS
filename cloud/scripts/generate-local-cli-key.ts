#!/usr/bin/env bun
/**
 * Generate a CLI API key for local development
 *
 * This script generates a JWT token that can be used to authenticate
 * the CLI against your local cloud instance.
 *
 * Usage:
 *   bun run scripts/generate-local-cli-key.ts [email]
 *
 * The generated token will be valid for 365 days and can be used with:
 *   mentra cloud use local
 *   mentra auth <generated-token>
 */

import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import chalk from "chalk";

// Get JWT secret from environment
const CLI_JWT_SECRET =
  process.env.CLI_AUTH_JWT_SECRET || process.env.CONSOLE_AUTH_JWT_SECRET || process.env.AUGMENTOS_AUTH_JWT_SECRET;

if (!CLI_JWT_SECRET) {
  console.error(chalk.red("✗ Missing JWT secret in environment"));
  console.error("  Set one of these environment variables:");
  console.error("  - CLI_AUTH_JWT_SECRET");
  console.error("  - CONSOLE_AUTH_JWT_SECRET");
  console.error("  - AUGMENTOS_AUTH_JWT_SECRET");
  process.exit(1);
}

// Get email from command line or use default
const email = process.argv[2] || "dev@local.test";
const keyName = "Local Development Key";
const keyId = uuidv4();
const expiresInDays = 365;

// Calculate expiration
const now = Math.floor(Date.now() / 1000);
const exp = now + expiresInDays * 24 * 60 * 60;

// Create JWT payload
const payload = {
  email,
  type: "cli",
  keyId,
  name: keyName,
  iat: now,
  exp,
};

// Generate token
const token = jwt.sign(payload, CLI_JWT_SECRET);

// Display results
console.log(chalk.bold("\n🔑 Local CLI API Key Generated\n"));
console.log(chalk.gray("═".repeat(60)));
console.log(chalk.cyan("Email:       ") + email);
console.log(chalk.cyan("Key ID:      ") + keyId);
console.log(chalk.cyan("Key Name:    ") + keyName);
console.log(chalk.cyan("Expires:     ") + new Date(exp * 1000).toLocaleDateString());
console.log(chalk.gray("═".repeat(60)));
console.log(chalk.bold("\n📋 Your CLI API Key:\n"));
console.log(chalk.green(token));
console.log(chalk.gray("\n═".repeat(60)));
console.log(chalk.bold("\n📝 Setup Instructions:\n"));
console.log(chalk.yellow("1.") + " Switch CLI to local cloud:");
console.log(chalk.gray("   cd packages/cli"));
console.log(chalk.gray("   bun run src/index.ts cloud use local"));
console.log();
console.log(chalk.yellow("2.") + " Authenticate with the generated token:");
console.log(chalk.gray("   bun run src/index.ts auth <token-above>"));
console.log();
console.log(chalk.yellow("3.") + " Or set as environment variable:");
console.log(chalk.gray("   export MENTRA_CLI_TOKEN=<token-above>"));
console.log();
console.log(chalk.yellow("4.") + " Test the connection:");
console.log(chalk.gray("   bun run src/index.ts org list"));
console.log(chalk.gray("\n═".repeat(60)));
console.log();

// Also save to a file for easy access
const tokenFile = new URL("../local-cli-token.txt", import.meta.url);
await Bun.write(tokenFile, token);
console.log(chalk.green("✓") + " Token also saved to: " + chalk.gray("local-cli-token.txt"));
console.log();
