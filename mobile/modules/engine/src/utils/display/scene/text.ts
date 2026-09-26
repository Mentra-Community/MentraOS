import {TextMeasurer} from "../measurer/TextMeasurer"
import type {DisplayProfile} from "../profiles/types"
import {TextWrapper} from "../wrapper/TextWrapper"
import type {SceneBox, SceneTextLayout, SceneTextLine, SceneTextStyle} from "./types"

/** Resolve source positions while wrapping, before truncation or inserted ellipses.
 * Matching is sequential within each paragraph: repeated words cannot jump to
 * another occurrence. The wrapper can collapse whitespace, insert CJK spaces,
 * and append a hyphen at a soft break; those don't invent source characters.
 */
export function sourceLines(
  text: string,
  width: number,
  style: SceneTextStyle,
  profile: DisplayProfile,
): SceneTextLine[] {
  const wrapper = new TextWrapper(new TextMeasurer(profile))
  const out: SceneTextLine[] = []
  let paragraphStart = 0
  for (const paragraph of text.split("\n")) {
    const wrapped = wrapper.wrap(paragraph, {
      maxWidthPx: width,
      maxLines: Infinity,
      maxBytes: Infinity,
      ...(style.breakMode ? {breakMode: style.breakMode} : {}),
    })
    // Match backwards so an inserted end-of-line hyphen cannot consume a
    // real hyphen at the start of the next line. Whitespace is normalized by
    // the wrapper, so only source glyphs advance the position.
    let cursor = paragraph.length
    const paragraphLines: SceneTextLine[] = []
    for (let i = wrapped.lines.length - 1; i >= 0; i--) {
      const line = wrapped.lines[i]
      while (cursor > 0 && /\s/.test(paragraph[cursor - 1])) cursor--
      let start = cursor
      let end = cursor
      let consumed = false
      const chars = Array.from(line)
      for (let j = chars.length - 1; j >= 0; j--) {
        const char = chars[j]
        if (/\s/.test(char)) continue
        while (cursor > 0 && /\s/.test(paragraph[cursor - 1])) cursor--
        if (paragraph.substring(cursor - char.length, cursor) === char) {
          if (!consumed) end = cursor
          consumed = true
          cursor -= char.length
          start = cursor
        }
      }
      paragraphLines.unshift({text: line, start: paragraphStart + start, end: paragraphStart + end})
    }
    out.push(...paragraphLines)
    paragraphStart += paragraph.length + 1
  }
  return out
}

/** Text selection belongs to the host; every call is a complete, stateless input. */
export function processText(
  text: string,
  box: SceneBox,
  style: SceneTextStyle,
  profile: DisplayProfile,
): {text: string; box: SceneBox; layout: SceneTextLayout; degraded: boolean} {
  const measurer = new TextMeasurer(profile)
  const heightLimit = profile.lineHeightPx ? Math.floor(box.h / profile.lineHeightPx) : profile.maxLines
  const requested = style.maxLines === undefined ? Infinity : Math.max(0, Math.floor(style.maxLines))
  const capacity = Math.max(0, Math.min(profile.maxLines, heightLimit, requested))
  const all = sourceLines(text, box.w, style, profile)
  const fromEnd = style.textWindow === "end"
  let lines = capacity === 0 ? [] : fromEnd ? all.slice(-capacity) : all.slice(0, capacity)

  // Select the requested end BEFORE applying transport budgets. Otherwise a
  // long transcript would lose its newest text before tail selection.
  while (lines.length && measurer.getByteSize(lines.map((l) => l.text).join("\n")) > profile.maxPayloadBytes) {
    lines = fromEnd ? lines.slice(1) : lines.slice(0, -1)
  }
  const truncated = lines.length < all.length
  if (truncated && style.overflow === "ellipsis" && lines.length) {
    const index = fromEnd ? 0 : lines.length - 1
    let chars = Array.from(lines[index].text)
    const decorate = () => (fromEnd ? `…${chars.join("")}` : `${chars.join("")}…`)
    const fits = () => {
      const candidate = lines.map((l, i) => (i === index ? decorate() : l.text)).join("\n")
      return measurer.fitsInWidth(decorate(), box.w) && measurer.getByteSize(candidate) <= profile.maxPayloadBytes
    }
    while (chars.length && !fits()) fromEnd ? chars.shift() : chars.pop()
    lines = lines.map((line, i) => (i === index ? {...line, text: fits() ? decorate() : ""} : line))
  }

  // Keep the chosen line region stable as an interim grows from one row to N.
  // This prevents bottom captions from jumping on every added line.
  let outputBox = box
  if (style.verticalAlign && profile.lineHeightPx) {
    const rows = style.maxLines === undefined ? lines.length : capacity
    const height = Math.min(box.h, Math.max(1, rows) * profile.lineHeightPx)
    outputBox = {...box, y: style.verticalAlign === "bottom" ? box.y + box.h - height : box.y, h: height}
  }
  return {
    text: lines.map((line) => line.text).join("\n"),
    box: outputBox,
    layout: {lines, lineStarts: all.map((line) => line.start), capacity, truncated},
    degraded: truncated || (style.verticalAlign === "bottom" && !profile.lineHeightPx),
  }
}
