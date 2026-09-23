import {execFileSync} from "node:child_process"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {iosInstallUrl} from "./pr-ios-artifacts-install.mjs"

const text = (value) => ({type: "text", text: value})
const link = (url, label) => ({type: "link", url, text: label})
const reachable = (url) => {
  if (!url?.startsWith("https://")) return false
  try {
    execFileSync("curl", ["--fail", "--silent", "--head", "--location", "--max-time", "20", "--retry", "2", url], {
      stdio: "ignore",
    })
    return true
  } catch {
    return false
  }
}

export function platformDownloads(env, check = reachable) {
  const apple = [env.IPHONE_MANIFEST_URL, env.IPHONE_SHARE_URL, env.MAC_URL].every((url) => check(url))
  const apk =
    env.MOBILE_APK_URL || (env.MOBILE_ASSET_BASE_URL && env.APK_NAME && `${env.MOBILE_ASSET_BASE_URL}/${env.APK_NAME}`)
  const ipa =
    env.MOBILE_IPA_URL || (env.MOBILE_ASSET_BASE_URL && env.IPA_NAME && `${env.MOBILE_ASSET_BASE_URL}/${env.IPA_NAME}`)
  const rows = [
    ["iphone", "Android", check(apk) ? [link(apk, "Download APK")] : []],
    [
      "iphone",
      "iOS",
      apple
        ? [
            link(iosInstallUrl(env.IPHONE_MANIFEST_URL), "Install on iPhone"),
            link(env.IPHONE_SHARE_URL, "Share install link"),
          ]
        : // Preserve useful historical store-IPA links on old-release notifications.
          !env.IPHONE_MANIFEST_URL && check(ipa)
          ? [link(ipa, "Download IPA")]
          : [],
    ],
    ["computer", "macOS", apple ? [link(env.MAC_URL, "Download ZIP")] : []],
  ]
  return [
    {
      type: "rich_text",
      elements: rows.map(([icon, name, links]) => ({
        type: "rich_text_section",
        elements: [
          {type: "emoji", name: icon},
          {...text(` ${name}`), style: {bold: true}},
          text(" — "),
          ...(links.length
            ? links.flatMap((item, index) => (index ? [text(" · "), item] : [item]))
            : [text("Downloads unavailable")]),
        ],
      })),
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Backend: *${env.BRANCH === "staging" ? "Staging" : "Dev"}* · Android ARM64${apple ? " · Apple devices must be registered" : ""}`,
        },
      ],
    },
  ]
}

export function otaTargetText(manifest, identity) {
  const asg = manifest.apps?.["com.mentra.asg_client"]
  if (
    manifest.releaseVersion !== identity ||
    !asg?.versionName ||
    !Number.isSafeInteger(asg.versionCode) ||
    asg.versionCode <= 0 ||
    !manifest.bes_firmware?.version ||
    !manifest.mtk_full_ota?.end_firmware
  )
    throw new Error("OTA targets do not match this coordinated release")
  const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return `ASG: *${escape(asg.versionName)}* · build ${asg.versionCode}\nBES: *${escape(manifest.bes_firmware.version)}*\nMTK: *${escape(manifest.mtk_full_ota.end_firmware)}*`
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "platforms") console.log(JSON.stringify(platformDownloads(process.env)))
  else if (process.argv[2] === "ota") {
    try {
      const response = await fetch(process.env.OTA_MANIFEST_URL, {signal: AbortSignal.timeout(20_000)})
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      console.log(otaTargetText(await response.json(), process.env.RELEASE_IDENTITY))
    } catch (error) {
      console.log(`OTA target details unavailable (${error.message})`)
    }
  } else throw new Error("Expected platforms or ota")
}
