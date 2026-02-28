/**
 * Authentication Commands
 *
 * Commands: auth, logout, whoami
 */

import {Command} from "commander"
import {saveCredentials, loadCredentials, clearCredentials} from "../config/credentials"
import {getCurrentCloud} from "../config/clouds"
import jwt from "jsonwebtoken"
import chalk from "chalk"

export const authCommand = new Command("auth")
  .description("Authenticate with CLI API key")
  .argument("<token>", "CLI API key from console")
  .action(async (token: string) => {
    try {
      // Validate token format
      const decoded = jwt.decode(token) as any
      if (!decoded || decoded.type !== "cli") {
        console.error(chalk.red("✗") + " Invalid CLI API key format")
        console.error("  Expected a CLI API key from the console")
        process.exit(2)
      }

      // Save credentials
      await saveCredentials(token)

      console.log(chalk.green("✓") + ` Authenticated as ${chalk.cyan(decoded.email)}`)
      console.log(chalk.green("✓") + ` CLI key: ${chalk.cyan(decoded.name)}`)

      const {cloud} = getCurrentCloud()
      console.log(chalk.green("✓") + ` Cloud: ${chalk.cyan(cloud.name)} (${cloud.url})`)
    } catch (error: any) {
      console.error(chalk.red("✗") + " Authentication failed:", error.message)
      process.exit(1)
    }
  })

// Logout command
authCommand
  .command("logout")
  .description("Clear stored credentials")
  .action(async () => {
    try {
      await clearCredentials()
      console.log(chalk.green("✓") + " Logged out")
    } catch (error: any) {
      console.error(chalk.red("✗") + " Failed to logout:", error.message)
      process.exit(1)
    }
  })

// Whoami command
authCommand
  .command("whoami")
  .description("Show current authentication info")
  .action(async () => {
    try {
      const creds = await loadCredentials()
      if (!creds) {
        console.error(chalk.red("✗") + " Not authenticated")
        console.error("  Run: mentra auth <token>")
        process.exit(3)
      }

      const {key: _cloudKey, cloud} = getCurrentCloud()

      console.log(`${chalk.cyan("Email:")}       ${creds.email}`)
      console.log(`${chalk.cyan("Cloud:")}       ${cloud.name} (${cloud.url})`)
      console.log(`${chalk.cyan("CLI Key:")}     ${creds.keyName}`)
      console.log(`${chalk.cyan("Stored:")}      ${new Date(creds.storedAt).toLocaleString()}`)
      if (creds.expiresAt) {
        console.log(`${chalk.cyan("Expires:")}     ${new Date(creds.expiresAt).toLocaleString()}`)
      }
    } catch (error: any) {
      console.error(chalk.red("✗") + " Error:", error.message)
      process.exit(1)
    }
  })
