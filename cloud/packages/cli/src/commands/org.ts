/**
 * Organization Management Commands
 *
 * Commands: org list, org get, org switch
 */

import {Command} from "commander"
import {api} from "../api/client"
import {requireAuth} from "../config/credentials"
import {displayTable, displayJSON, success, error} from "../utils/output"
import {updateConfig} from "../config/settings"
import chalk from "chalk"

export const orgCommand = new Command("org").description("Manage organizations")

// List organizations
orgCommand
  .command("list")
  .alias("ls")
  .description("List organizations")
  .option("--json", "Output JSON")
  .action(async (options) => {
    try {
      await requireAuth()
      const orgs = await api.listOrgs()

      if (options.json || options.parent?.opts().json) {
        displayJSON(orgs)
      } else {
        if (orgs.length === 0) {
          console.log("No organizations found")
          return
        }

        const rows = orgs.map((org: any) => ({
          id: org.id,
          name: org.name,
          slug: org.slug,
          members: org.members?.length || 0,
        }))

        displayTable(rows, ["id", "name", "slug", "members"])
        console.log(`\n${chalk.cyan(orgs.length)} organizations total`)
      }
    } catch (err: any) {
      error(`Failed to list organizations: ${err.message}`)
      process.exit(1)
    }
  })

// Get organization details
orgCommand
  .command("get")
  .argument("[org-id]", "Organization ID (defaults to current org)")
  .description("Get organization details")
  .action(async (orgId?: string) => {
    try {
      await requireAuth()

      if (!orgId) {
        // Get default org from config
        const {getConfig} = await import("../config/settings")
        const config = getConfig()
        orgId = config.default?.org

        if (!orgId) {
          error("No organization ID provided and no default org set")
          console.error("  Run: mentra org switch <org-id>")
          process.exit(1)
        }
      }

      const org = await api.getOrg(orgId)
      displayJSON(org)
    } catch (err: any) {
      error(`Organization not found: ${err.message}`)
      process.exit(5)
    }
  })

// Switch default organization
orgCommand
  .command("switch")
  .argument("<org-id>", "Organization ID")
  .description("Set default organization")
  .action(async (orgId: string) => {
    try {
      await requireAuth()

      // Verify org exists
      const org = await api.getOrg(orgId)

      // Update config
      const {getConfig} = await import("../config/settings")
      const config = getConfig()
      const defaultConfig = config.default || {}
      defaultConfig.org = orgId

      updateConfig({default: defaultConfig})

      success(`Switched to ${chalk.cyan(org.name)} (${orgId})`)
    } catch (err: any) {
      error(`Failed to switch organization: ${err.message}`)
      process.exit(1)
    }
  })
