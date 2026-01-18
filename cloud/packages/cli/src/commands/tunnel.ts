/**
 * Tunnel Command
 *
 * Commands: tunnel
 */

import {Command} from "commander"
import localtunnel from "localtunnel"
import chalk from "chalk"

// Type for request info from localtunnel
interface TunnelRequestInfo {
  method?: string
  path?: string
}

export const tunnelCommand = new Command("tunnel")
  .description("Start reverse tunnel to localhost")
  .option("-p, --port <port>", "Local server port", "3000")
  .option("-s, --subdomain <subdomain>", "Request specific subdomain")
  .option("--host <host>", "Tunnel server URL", "https://tunnel.mentra.run")
  .action(async (options) => {
    const port = parseInt(options.port, 10)
    const subdomain = options.subdomain
    const host = options.host

    // Validate port
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(chalk.red("✗") + ` Invalid port: ${options.port}`)
      console.error(chalk.gray("  Port must be a number between 1 and 65535"))
      process.exit(2)
    }

    try {
      console.log(chalk.cyan("🔗 Starting tunnel..."))
      console.log(chalk.gray(`   Port: ${port}`))
      if (subdomain) {
        console.log(chalk.gray(`   Requested subdomain: ${subdomain}`))
      }
      console.log(chalk.gray(`   Server: ${host}`))
      console.log()

      // Create tunnel
      const tunnel = await localtunnel({
        port,
        subdomain,
        host,
      })

      // Display tunnel URL
      console.log(chalk.green("✓") + " Tunnel active!")
      console.log()
      console.log(chalk.bold(`  🔗 Tunnel URL: ${chalk.cyan(tunnel.url)}`))
      console.log(chalk.bold(`  🏠 Forwarding to: ${chalk.cyan(`http://localhost:${port}`)}`))
      console.log()
      console.log(chalk.yellow("⚠️  Update publicUrl in console: ") + chalk.cyan("https://console.mentra.glass"))
      console.log()
      console.log(chalk.gray("Waiting for connections... (Ctrl+C to stop)"))
      console.log()

      // Track request count
      let requestCount = 0

      // Listen for incoming requests
      tunnel.on("request", (info: TunnelRequestInfo) => {
        requestCount++
        const timestamp = new Date().toLocaleTimeString()
        const method = info.method || "GET"
        const path = info.path || "/"

        // Colored output based on method
        let methodColor = chalk.blue
        if (method === "POST") methodColor = chalk.green
        if (method === "PUT" || method === "PATCH") methodColor = chalk.yellow
        if (method === "DELETE") methodColor = chalk.red

        console.log(`[${chalk.gray(timestamp)}] ${methodColor(method.padEnd(6))} ${chalk.cyan(path)}`)
      })

      // Handle errors
      tunnel.on("error", (err: any) => {
        console.error(chalk.red("✗") + " Tunnel error:", err.message)
      })

      // Handle close
      tunnel.on("close", () => {
        console.log()
        console.log(chalk.yellow("⚠️  Tunnel closed"))
        console.log(chalk.gray(`   Total requests: ${requestCount}`))
        process.exit(0)
      })

      // Graceful shutdown on Ctrl+C
      process.on("SIGINT", () => {
        console.log()
        console.log(chalk.yellow("⏸  Shutting down tunnel..."))
        tunnel.close()
      })

      process.on("SIGTERM", () => {
        tunnel.close()
      })
    } catch (err: any) {
      console.error(chalk.red("✗") + " Failed to start tunnel:", err.message)
      console.error()

      // Provide helpful error messages
      if (err.message.includes("ECONNREFUSED")) {
        console.error(chalk.yellow("💡 Tip:") + " Make sure your local server is running on port " + port)
        console.error(chalk.gray("   Try: bun run dev"))
      } else if (err.message.includes("tunnel server")) {
        console.error(chalk.yellow("💡 Tip:") + " Cannot connect to tunnel server")
        console.error(chalk.gray(`   Server: ${host}`))
        console.error(chalk.gray("   Try using --host https://loca.lt to test with public server"))
      }

      process.exit(1)
    }
  })
