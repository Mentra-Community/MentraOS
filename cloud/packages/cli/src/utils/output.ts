/**
 * Output Utilities
 *
 * Helpers for formatting CLI output (tables, JSON, etc.)
 */

import Table from "cli-table3"
import chalk from "chalk"

/**
 * Display data as a formatted table
 */
export function displayTable(data: any[], columns: string[]): void {
  if (data.length === 0) {
    console.log("No data to display")
    return
  }

  const table = new Table({
    head: columns.map((col) => chalk.cyan(col)),
    style: {
      head: [],
      border: ["grey"],
    },
  })

  data.forEach((item) => {
    const row = columns.map((col) => {
      const value = item[col]
      if (value === undefined || value === null) return ""
      return String(value)
    })
    table.push(row)
  })

  console.log(table.toString())
}

/**
 * Display data as JSON
 */
export function displayJSON(data: any): void {
  console.log(JSON.stringify(data, null, 2))
}

/**
 * Format output based on global options
 */
export function display(data: any, options?: {json?: boolean; columns?: string[]}): void {
  if (options?.json) {
    displayJSON(data)
  } else if (options?.columns && Array.isArray(data)) {
    displayTable(data, options.columns)
  } else {
    displayJSON(data)
  }
}

/**
 * Display success message
 */
export function success(message: string): void {
  console.log(chalk.green("✓") + " " + message)
}

/**
 * Display error message
 */
export function error(message: string): void {
  console.error(chalk.red("✗") + " " + message)
}

/**
 * Display warning message
 */
export function warning(message: string): void {
  console.warn(chalk.yellow("⚠") + " " + message)
}

/**
 * Display info message
 */
export function info(message: string): void {
  console.log(chalk.blue("ℹ") + " " + message)
}
