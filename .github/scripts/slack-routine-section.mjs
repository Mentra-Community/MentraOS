export const SLACK_SECTION_LIMIT = 3000

/** Shorten before escaping so neither entities nor Slack links are cut in half. */
export function slackRoutineText(value, maximum = 240) {
  const characters = Array.from(String(value).replace(/[\r\n]/g, " "))
  const text = characters.length > maximum ? `${characters.slice(0, maximum - 1).join("")}…` : characters.join("")
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

/** Keep whole deterministic rows within Slack's section limit and retain an Admin overflow link. */
export function slackRoutineSection({heading, detail, lines, footer, overflowUrl, overflowLabel}) {
  const prefix = [heading, detail].filter(Boolean).join("\n"), suffix = footer ? `\n${footer}` : ""
  const complete = `${prefix}${lines.length ? `\n${lines.join("\n")}` : ""}${suffix}`
  if (complete.length <= SLACK_SECTION_LIMIT) return complete
  const overflow = `\n<${overflowUrl}|${overflowLabel}>`
  if (`${prefix}${overflow}${suffix}`.length > SLACK_SECTION_LIMIT) throw new Error("Routine section summary exceeds Slack's limit")
  let rendered = prefix
  for (const line of lines) {
    if (`${rendered}\n${line}${overflow}${suffix}`.length > SLACK_SECTION_LIMIT) break
    rendered += `\n${line}`
  }
  return `${rendered}${overflow}${suffix}`
}
