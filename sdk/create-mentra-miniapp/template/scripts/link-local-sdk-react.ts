#!/usr/bin/env bun

import {existsSync, lstatSync, realpathSync, rmSync, symlinkSync} from "fs"
import {dirname, join, resolve} from "path"
import {fileURLToPath} from "url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const installedSdkRoot = join(root, "node_modules", "@mentra", "miniapp")
const appReact = join(root, "node_modules", "react")

if (!existsSync(appReact) || !existsSync(installedSdkRoot)) {
  process.exit(0)
}

function linkReactPeer(sdkRoot: string): void {
  const sdkReact = join(sdkRoot, "node_modules", "react")
  if (!existsSync(dirname(sdkReact))) return
  if (existsSync(sdkReact) || lstatSync(sdkReact, {throwIfNoEntry: false})) {
    rmSync(sdkReact, {recursive: true, force: true})
  }
  symlinkSync(appReact, sdkReact, "dir")
}

try {
  linkReactPeer(installedSdkRoot)
  linkReactPeer(dirname(realpathSync(join(installedSdkRoot, "package.json"))))
  console.log("[create-mentra-miniapp] linked SDK React peer to app React")
} catch (error) {
  console.warn("[create-mentra-miniapp] could not link SDK React peer", error)
}
