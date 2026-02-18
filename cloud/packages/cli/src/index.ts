#!/usr/bin/env bun
/**
 * Mentra CLI
 *
 * Command-line tool for managing Mentra apps and organizations
 */

import {Command} from "commander"
import {authCommand} from "./commands/auth"
import {cloudCommand} from "./commands/cloud"
import {appCommand} from "./commands/app"
import {orgCommand} from "./commands/org"

const program = new Command()

program.name("mentra").description("Mentra CLI - Manage apps and organizations").version("1.0.0")

// Add commands
program.addCommand(authCommand)
program.addCommand(cloudCommand)
program.addCommand(appCommand)
program.addCommand(orgCommand)

// Global options
program.option("--json", "Output JSON")
program.option("--quiet", "Suppress non-essential output")
program.option("--verbose", "Show debug info")
program.option("--no-color", "Disable colors")

// Parse arguments
program.parse()
