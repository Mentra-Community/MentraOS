#!/usr/bin/env bun
/**
 * @mentra/js CLI
 *
 * Commands:
 *   mentra dev     — Start development server with HMR
 *   mentra build   — Bundle for production
 *   mentra init    — Scaffold a new project
 */

const command = process.argv[2];

switch (command) {
  case "dev":
    await import("./src/dev");
    break;
  case "build":
    await import("./src/build");
    break;
  case "init":
    await import("./src/init");
    break;
  default:
    console.log(`
  😎 @mentra/js — MentraOS App Framework

  Commands:
    mentra dev     Start dev server with HMR + QR code
    mentra build   Bundle for production
    mentra init    Scaffold a new project

  Usage:
    cd my-app
    mentra dev
`);
    if (command) {
      console.error(`  Unknown command: ${command}\n`);
      process.exit(1);
    }
}
