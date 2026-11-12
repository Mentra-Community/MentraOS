// Every Slack build post, in one layout: the PR builds in #pr-builds, the dev
// and staging releases, and the lab's nightly results and device notices
// (testing/agent/slack.ts). Buttons, never inline links:
//
//   ✅ PR #123 ready to test: <title>                         [Details]
//   feature → dev · by someone · abc1234 · Dev backend
//   [🤖 Mentra] [🍎 Mentra] [🤖 Bluetooth example] [🍎 Bluetooth example] [📚 Docs]
//   ➖ Missing: 🍎 Bluetooth example (failed)
//   🕶️ ASG 3.4.0 (build 340) · BES 26.11.4.0 · MTK MentraLive_20261101
//   ⚠️ <each problem, with its logs>                         [Logs]
//
// Details opens the page that has everything else: the PR comment, or the
// release page.

/** Shorten before escaping so neither entities nor Slack links are cut in half. */
export function slackText(value, maximum = 240) {
  const characters = Array.from(String(value).replace(/[\r\n]/g, " "))
  const text = characters.length > maximum ? `${characters.slice(0, maximum - 1).join("")}…` : characters.join("")
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

const plain = (value, maximum) => {
  const characters = Array.from(String(value))
  return characters.length > maximum ? `${characters.slice(0, maximum - 1).join("")}…` : characters.join("")
}
// Slack refuses a button whose URL is not http(s), so iPhone opens the HTTPS install page, never itms-services.
const button = (label, url, style) => ({
  type: "button",
  text: {type: "plain_text", text: plain(label, 75), emoji: true},
  url,
  ...(style ? {style} : {}),
})
const context = (text) => ({type: "context", elements: [{type: "mrkdwn", text}]})

const PLATFORM_EMOJI = {Android: ":robot_face:", iOS: ":apple:", macOS: ":computer:"}

/** Each channel's docs root, by the branch a release or PR build belongs to. */
export const DOCS = {
  dev: "https://docs-dev.mentraglass.com",
  staging: "https://docs-beta.mentraglass.com",
  main: "https://docs.mentraglass.com",
}

const installable = (url) => /^https:\/\//.test(url ?? "")

/**
 * Mentra, then the Bluetooth example, each `{name, installs: [{platform, url?, missing?}]}`, with the same
 * slots: Android and iOS, and macOS when either app built it. Each is labelled by the app's name, its
 * platform by the emoji. A slot without an HTTPS URL is missing, for `missing`'s reason. Mentra's buttons
 * stand out.
 */
export function installSlots(apps) {
  const platforms = ["Android", "iOS",
    ...(apps.some(({installs}) => installs.some(({platform, url}) => platform === "macOS" && installable(url))) ? ["macOS"] : [])]
  return apps.flatMap(({name, installs}, index) => platforms.map((platform) => {
    const install = installs.find((entry) => entry.platform === platform)
    return {label: `${PLATFORM_EMOJI[platform]} ${name}`, emoji: PLATFORM_EMOJI[platform], name, primary: !index,
      ...(installable(install?.url) ? {url: install.url} : {missing: install?.missing ?? "not built"})}
  }))
}

export function installButtons(apps) {
  return installSlots(apps).filter(({url}) => url)
    .map(({emoji, name, primary, url}) => button(`${emoji} Install ${name}`, url, primary ? "primary" : undefined))
}

/** The glasses versions an OTA manifest of this release or PR build (`releaseVersion`) targets. */
export function otaTargets(manifest, releaseVersion) {
  if (manifest?.releaseVersion !== releaseVersion) throw new Error("OTA manifest belongs to a different build")
  const asg = manifest.apps?.["com.mentra.asg_client"]
  const bes = manifest.bes_firmware?.version
  const mtk = manifest.mtk_full_ota?.end_firmware
  if (!asg?.versionName || !Number.isSafeInteger(asg.versionCode) || asg.versionCode <= 0 || !bes || !mtk)
    throw new Error("OTA manifest is missing ASG, BES or MTK target metadata")
  return {asg, bes, mtk}
}

/** `{asg: {versionName, versionCode}, bes, mtk}` as one line. */
export const glassesLine = ({asg, bes, mtk}) =>
  `:dark_sunglasses: ASG *${slackText(asg.versionName, 120)}* (build ${asg.versionCode}) · BES *${slackText(bes, 120)}* · MTK *${slackText(mtk, 120)}*`

/**
 * A build post: `title` is mrkdwn already escaped, `facts` plain strings for the small line under it, `problems`
 * `{text, url?, icon?}` (mrkdwn text; `url` its logs; ⚠️ unless `icon`) and `details` the page with everything else.
 * `docs` adds a Docs button after the installs. Problems past Slack's 50 blocks to a message are counted, for
 * Details to show.
 * @param {{text: string, title: string, details?: string, facts?: string[],
 *   apps?: {name: string, installs: {platform: string, url?: string, missing?: string}[]}[], docs?: string,
 *   glasses?: {asg: {versionName: string, versionCode: number}, bes: string, mtk: string}, glassesNote?: string,
 *   problems?: {text: string, url?: string, icon?: string}[]}} post
 */
export function buildPost({text, title, details, facts = [], apps = [], docs, glasses, glassesNote, problems = []}) {
  const buttons = [...installButtons(apps), ...(installable(docs) ? [button(":books: Docs", docs)] : [])]
  const missing = installSlots(apps).filter(({url}) => !url)
  const top = [
    {type: "section", text: {type: "mrkdwn", text: title}, ...(details ? {accessory: button("Details", details)} : {})},
    ...(facts.length ? [context(facts.map((fact) => slackText(fact, 200)).join(" · "))] : []),
    // Slack allows 25 elements to an actions block.
    ...(buttons.length ? [{type: "actions", elements: buttons.slice(0, 25)}] : []),
    ...(missing.length ? [context(`:heavy_minus_sign: Missing: ${missing.map(({label, missing}) =>
      `${label} (${slackText(missing, 80)})`).join(" · ")}`)] : []),
    ...(glasses ? [context(glassesLine(glasses))] : glassesNote ? [context(`:dark_sunglasses: ${slackText(glassesNote, 200)}`)] : []),
  ]
  // Slack takes 50 blocks to a message: past that, one counts the rest.
  const shown = top.length + problems.length > 50 ? 49 - top.length : problems.length
  return {
    text,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      ...top,
      ...problems.slice(0, shown).map((problem) => ({
        type: "section",
        text: {type: "mrkdwn", text: `${problem.icon ?? ":warning:"} ${problem.text}`},
        ...(problem.url ? {accessory: button("Logs", problem.url)} : {}),
      })),
      ...(problems.length > shown ? [context(`…and ${problems.length - shown} more${details ? ", in Details" : ""}`)] : []),
    ],
  }
}

/** POST to an incoming webhook once: an ambiguous network failure must not duplicate a post. */
export async function postToWebhook(webhook, payload, fetchImpl = fetch) {
  const response = await fetchImpl(webhook, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok || (await response.text()).trim() !== "ok")
    throw new Error(`Slack rejected the build post (${response.status})`)
}
