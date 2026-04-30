#!/usr/bin/env bun

import {existsSync} from "fs"
import {cp, mkdir, readFile, writeFile} from "fs/promises"
import {basename, dirname, join, resolve} from "path"
import {fileURLToPath} from "url"
import {confirm, intro, isCancel, outro, text} from "@clack/prompts"

const here = dirname(fileURLToPath(import.meta.url))
const templateDir = resolve(here, "..", "template")
const DEFAULT_HARDWARE_REQUIREMENTS = [{type: "DISPLAY", level: "REQUIRED"}]

interface CliArgs {
  target?: string
  yes: boolean
  packageName?: string
  name?: string
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {yes: false}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--yes" || arg === "-y") {
      result.yes = true
      continue
    }
    if (arg === "--package-name") {
      result.packageName = argv[++i]
      continue
    }
    if (arg === "--name") {
      result.name = argv[++i]
      continue
    }
    if (!arg.startsWith("-") && !result.target) {
      result.target = arg
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return result
}

function cancel(message = "Cancelled"): void {
  outro(message)
  process.exit(1)
}

function slugToPackageName(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function defaultPackageName(projectName: string): string {
  const slug = slugToPackageName(basename(projectName))
  return `com.mentra.${slug.replace(/-/g, "_")}`
}

function toDisplayName(projectName: string): string {
  return basename(projectName)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (match: string) => match.toUpperCase())
}

async function replaceInFile(path: string, replacements: Record<string, string>): Promise<void> {
  let contents = await readFile(path, "utf8")
  for (const [key, value] of Object.entries(replacements)) {
    contents = contents.replaceAll(`{{${key}}}`, value)
  }
  await writeFile(path, contents)
}

function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

async function writeGeneratedManifest(targetDir: string, packageName: string, appName: string): Promise<void> {
  const manifest = {
    $schema: "./node_modules/@mentra/miniapp-cli/schema/miniapp.schema.json",
    packageName,
    version: "1.0.0",
    name: appName,
    description: "A MentraOS miniapp",
    icon: "icon.png",
    port: 3000,
    permissions: [],
    hardwareRequirements: DEFAULT_HARDWARE_REQUIREMENTS,
  }
  await writeFile(join(targetDir, "miniapp.json"), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function main(): Promise<void> {
  intro("create-mentra-miniapp")

  const args = parseArgs(process.argv.slice(2))
  const argTarget = args.target
  const targetAnswer =
    argTarget ??
    (await text({
      message: "Where should the miniapp be created?",
      placeholder: "my-miniapp",
      validate(value) {
        if (!value?.trim()) return "Project directory is required"
      },
    }))

  if (isCancel(targetAnswer)) cancel()

  const targetInput = String(targetAnswer)
  const targetDir = resolve(targetInput)
  const projectName = basename(targetDir)

  if (existsSync(targetDir)) {
    const overwrite = await confirm({
      message: `${targetDir} already exists. Continue if it is empty or you want to merge template files?`,
      initialValue: false,
    })
    if (isCancel(overwrite) || !overwrite) cancel()
  }

  const fallbackPackageName = defaultPackageName(projectName)
  const packageAnswer =
    args.packageName ??
    (args.yes
      ? fallbackPackageName
      : await text({
          message: "Miniapp package name",
          initialValue: fallbackPackageName,
          validate(value) {
            if (!value || !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(value)) {
              return "Use reverse-DNS format, for example com.mentra.my_app"
            }
          },
        }))
  if (isCancel(packageAnswer)) cancel()

  const fallbackName = toDisplayName(projectName)
  const nameAnswer =
    args.name ??
    (args.yes
      ? fallbackName
      : await text({
          message: "Display name",
          initialValue: fallbackName,
          validate(value) {
            if (!value?.trim()) return "Display name is required"
          },
        }))
  if (isCancel(nameAnswer)) cancel()

  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(String(packageAnswer))) {
    throw new Error(`Invalid package name: ${String(packageAnswer)}`)
  }

  await mkdir(targetDir, {recursive: true})
  await cp(templateDir, targetDir, {recursive: true})

  const replacements = {
    projectName: jsonStringContent(projectName),
    appNameHtml: escapeHtmlText(String(nameAnswer)),
    appNameTsString: jsonStringContent(String(nameAnswer)),
  }

  await Promise.all([
    replaceInFile(join(targetDir, "package.json"), replacements),
    replaceInFile(join(targetDir, "index.html"), replacements),
    replaceInFile(join(targetDir, "src", "App.tsx"), replacements),
    writeGeneratedManifest(targetDir, String(packageAnswer), String(nameAnswer)),
  ])

  outro(`Created ${projectName}. Next: cd ${targetDir} && bun install && bun run dev`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
