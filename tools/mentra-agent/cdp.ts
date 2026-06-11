#!/usr/bin/env bun
/**
 * Tiny Chrome-DevTools-Protocol driver for the miniapp WebView (forwarded to
 * localhost:9223 via `adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>`).
 *
 *   bun cdp.ts eval '<js>'           evaluate in the page, print the result
 *   bun cdp.ts click "<text>"        click the first element whose text matches
 *   bun cdp.ts text                  dump the page's visible text
 *
 * Used by the SDK-conformance run to drive the example miniapp's Tester UI.
 */
const PORT = process.env.CDP_PORT ?? "9223"
const PAGE_MATCH = process.env.CDP_PAGE ?? "Mentra Example"

async function attach(): Promise<WebSocket> {
  const pages = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Array<{
    title: string
    url: string
    webSocketDebuggerUrl: string
  }>
  const page = pages.find((p) => p.title.includes(PAGE_MATCH) || p.url.includes(PAGE_MATCH))
  if (!page) throw new Error(`no CDP page matching "${PAGE_MATCH}" (have: ${pages.map((p) => p.title).join(", ")})`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  return ws
}

let seq = 0
function call(ws: WebSocket, method: string, params: unknown): Promise<any> {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data))
      if (m.id === id) {
        ws.removeEventListener("message", onMsg)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      }
    }
    ws.addEventListener("message", onMsg)
    ws.send(JSON.stringify({id, method, params}))
    setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 15000)
  })
}

async function evalJs(ws: WebSocket, expr: string): Promise<unknown> {
  const r = await call(ws, "Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed")
  return r.result?.value
}

const CLICK_BY_TEXT = (text: string) => `
(() => {
  const want = ${JSON.stringify(text)}.toLowerCase()
  const els = [...document.querySelectorAll("button, [role=button], a, div, span, li")]
  const el = els.find(e => (e.textContent || "").trim().toLowerCase() === want)
        ?? els.find(e => (e.textContent || "").trim().toLowerCase().includes(want) && e.children.length <= 3)
  if (!el) return "NOT_FOUND"
  el.scrollIntoView({block: "center"})
  el.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}))
  el.dispatchEvent(new MouseEvent("mouseup", {bubbles: true}))
  el.click()
  return "CLICKED " + (el.tagName + ":" + (el.textContent || "").trim().slice(0, 40))
})()`

const [cmd, ...rest] = process.argv.slice(2)
const ws = await attach()
try {
  if (cmd === "eval") {
    console.log(JSON.stringify(await evalJs(ws, rest.join(" ")), null, 2))
  } else if (cmd === "click") {
    console.log(await evalJs(ws, CLICK_BY_TEXT(rest.join(" "))))
  } else if (cmd === "text") {
    console.log(await evalJs(ws, `document.body.innerText`))
  } else {
    console.log("usage: cdp.ts {eval <js>|click <text>|text}")
  }
} finally {
  ws.close()
}
