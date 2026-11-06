// Every Slack build post, in one layout: the PR builds in #pr-builds and the
// dev and staging releases. Buttons, never inline links:
//
//   ✅ PR #123 ready to test: <title>                         [Details]
//   feature → dev · by someone · abc1234 · Dev backend
//   [Android] [iPhone] [Mac] [Bluetooth example Android] ...
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

const PLATFORM_EMOJI = {Android: ":robot_face:", iPhone: ":iphone:", Mac: ":computer:", "Google Play": ":robot_face:",
  TestFlight: ":apple:", Docs: ":books:"}

/**
 * The Mentra App, then the Bluetooth example, each `{name, installs: [{platform, url}]}`: the Mentra App's
 * buttons are named by platform alone and stand out; every other app's carry its name. An app without
 * installs has no buttons.
 */
export function installButtons(apps) {
  return apps.flatMap(({name, installs}, index) =>
    installs
      .filter(({url}) => /^https:\/\//.test(url ?? ""))
      .map(({platform, url}) =>
        button(`${PLATFORM_EMOJI[platform] ?? ""} ${index ? `${name} ${platform}` : platform}`.trim(), url, index ? undefined : "primary")),
  )
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
 * `{text, url?}` (mrkdwn text; `url` its logs) and `details` the page with everything else.
 */
export function buildPost({text, title, details, facts = [], apps = [], glasses, glassesNote, problems = []}) {
  const buttons = installButtons(apps)
  return {
    text,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      {type: "section", text: {type: "mrkdwn", text: title}, ...(details ? {accessory: button("Details", details)} : {})},
      ...(facts.length ? [context(facts.map((fact) => slackText(fact, 200)).join(" · "))] : []),
      // Slack allows 25 elements to an actions block.
      ...(buttons.length ? [{type: "actions", elements: buttons.slice(0, 25)}] : []),
      ...(glasses ? [context(glassesLine(glasses))] : glassesNote ? [context(`:dark_sunglasses: ${slackText(glassesNote, 200)}`)] : []),
      ...problems.map((problem) => ({
        type: "section",
        text: {type: "mrkdwn", text: `:warning: ${problem.text}`},
        ...(problem.url ? {accessory: button("Logs", problem.url)} : {}),
      })),
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
