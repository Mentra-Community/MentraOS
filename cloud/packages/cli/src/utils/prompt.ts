/**
 * Prompt Utilities
 *
 * Helpers for interactive CLI prompts
 */

import inquirer from "inquirer"

/**
 * Prompt for text input
 */
export async function input(
  message: string,
  options?: {
    required?: boolean
    default?: string
  },
): Promise<string> {
  const answer = await inquirer.prompt([
    {
      type: "input",
      name: "value",
      message,
      default: options?.default,
      validate: (value: string) => {
        if (options?.required && !value.trim()) {
          return "This field is required"
        }
        return true
      },
    },
  ])
  return answer.value
}

/**
 * Prompt for confirmation (yes/no)
 */
export async function confirm(message: string, defaultValue = false): Promise<boolean> {
  const answer = await inquirer.prompt([
    {
      type: "confirm",
      name: "value",
      message,
      default: defaultValue,
    },
  ])
  return answer.value
}

/**
 * Prompt for selection from a list
 */
export async function select(message: string, choices: string[]): Promise<string> {
  const answer = await inquirer.prompt([
    {
      type: "list",
      name: "value",
      message,
      choices,
    },
  ])
  return answer.value
}

/**
 * Prompt for multiple selections
 */
export async function multiSelect(message: string, choices: string[]): Promise<string[]> {
  const answer = await inquirer.prompt([
    {
      type: "checkbox",
      name: "value",
      message,
      choices,
    },
  ])
  return answer.value
}

/**
 * Prompt for password input (hidden)
 */
export async function password(message: string): Promise<string> {
  const answer = await inquirer.prompt([
    {
      type: "password",
      name: "value",
      message,
      mask: "*",
    },
  ])
  return answer.value
}
