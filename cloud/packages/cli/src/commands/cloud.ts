/**
 * Cloud Management Commands
 *
 * Commands: cloud list, cloud use, cloud add, cloud remove, cloud current
 */

import {Command} from "commander"
import {getAllClouds, getCurrentCloud, switchCloud, addCloud, removeCloud} from "../config/clouds"
import {displayTable} from "../utils/output"
import chalk from "chalk"

export const cloudCommand = new Command("cloud").description("Manage Mentra clouds")

// List clouds
cloudCommand
  .command("list")
  .alias("ls")
  .description("List available clouds")
  .action(() => {
    try {
      const allClouds = getAllClouds()
      const {key: currentKey} = getCurrentCloud()

      const rows = Object.entries(allClouds).map(([key, cloud]) => ({
        current: key === currentKey ? "*" : " ",
        key,
        name: cloud.name,
        url: cloud.url,
        type: cloud.builtin ? "built-in" : "custom",
      }))

      displayTable(rows, ["current", "key", "name", "url", "type"])
      console.log(`\n* = current cloud`)
    } catch (error: any) {
      console.error(chalk.red("✗") + " Error:", error.message)
      process.exit(1)
    }
  })

// Show current cloud
cloudCommand
  .command("current")
  .description("Show current cloud")
  .action(() => {
    try {
      const {key, cloud} = getCurrentCloud()
      console.log(`${key} (${cloud.url})`)
    } catch (error: any) {
      console.error(chalk.red("✗") + " Error:", error.message)
      process.exit(1)
    }
  })

// Switch cloud
cloudCommand
  .command("use")
  .argument("<cloud>", "Cloud to switch to")
  .description("Switch to a different cloud")
  .action((cloudKey: string) => {
    try {
      const {cloud: oldCloud} = getCurrentCloud()

      switchCloud(cloudKey)
      const newCloud = getAllClouds()[cloudKey]

      console.log(chalk.green("✓") + ` Switched from ${oldCloud.url}`)
      console.log(`  to ${chalk.cyan(newCloud.name)} (${newCloud.url})`)
    } catch (error: any) {
      console.error(chalk.red("✗") + " Error:", error.message)
      process.exit(1)
    }
  })

// Add custom cloud
cloudCommand
  .command("add")
  .argument("[key]", "Cloud key (e.g., my-staging)")
  .option("--name <name>", "Display name")
  .option("--url <url>", "API URL")
  .description("Add a custom cloud")
  .action(async (key?: string, options?: any) => {
    try {
      let cloudKey = key
      let name = options?.name
      let url = options?.url

      // Check if all required arguments provided
      if (!cloudKey || !name || !url) {
        console.error(chalk.red("✗") + " Missing required arguments")
        console.error("  Usage: mentra cloud add <key> --name <name> --url <url>")
        console.error("  Example: mentra cloud add my-cloud --name 'My Cloud' --url https://api.example.com")
        process.exit(2)
      }

      addCloud(cloudKey!, {name, url})
      console.log(chalk.green("✓") + ` Added cloud '${chalk.cyan(cloudKey)}'`)
    } catch (error: any) {
      console.error(chalk.red("✗") + " Error:", error.message)
      process.exit(1)
    }
  })

// Remove custom cloud
cloudCommand
  .command("remove")
  .alias("rm")
  .argument("<cloud>", "Cloud to remove")
  .description("Remove a custom cloud")
  .action((cloudKey: string) => {
    try {
      removeCloud(cloudKey)
      console.log(chalk.green("✓") + ` Removed cloud '${chalk.cyan(cloudKey)}'`)
    } catch (error: any) {
      console.error(chalk.red("✗") + " Error:", error.message)
      process.exit(1)
    }
  })
