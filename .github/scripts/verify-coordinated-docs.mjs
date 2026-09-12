import {readFileSync} from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"

export function verifyCoordinatedDocs(html, {releaseIdentity, apkUrl, iosUrl}) {
  for (const [label, value] of Object.entries({releaseIdentity, apkUrl, iosUrl})) {
    if (!value) throw new Error(`Missing expected ${label}`)
  }
  if (html.includes("A parsing error occurred")) throw new Error("Mintlify exported a parsing-error page")
  if (/\{\{[a-z0-9_-]+\}\}|%7b%7b[a-z0-9_-]+%7d%7d/i.test(html)) {
    throw new Error("Unresolved documentation variable")
  }
  if (!html.includes(releaseIdentity)) throw new Error(`Page is missing release ${releaseIdentity}`)
  for (const url of [apkUrl, iosUrl]) {
    const escaped = url.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    if (!html.includes(`href="${escaped}"`)) throw new Error(`Page is missing install link ${url}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  verifyCoordinatedDocs(readFileSync(process.argv[2], "utf8"), {
    releaseIdentity: process.env.RELEASE_IDENTITY,
    apkUrl: process.env.EXAMPLE_APK_URL,
    iosUrl: process.env.EXAMPLE_IOS_URL,
  })
}
