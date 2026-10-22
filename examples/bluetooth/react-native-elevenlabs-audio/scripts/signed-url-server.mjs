#!/usr/bin/env node

import {createServer} from "node:http"

const DEFAULT_AGENT_ID = "agent_0301ks3wg64pf9evgxqa6dw34t1f"
const port = Number(process.env.ELEVENLABS_SIGNING_SERVER_PORT || 8788)
const apiKey = process.env.ELEVENLABS_API_KEY
const defaultAgentId = process.env.ELEVENLABS_AGENT_ID || process.env.EXPO_PUBLIC_ELEVENLABS_AGENT_ID || DEFAULT_AGENT_ID

if (!apiKey) {
  console.error("ELEVENLABS_API_KEY is required for the local signing server.")
  process.exit(1)
}

async function fetchSignedUrl(agentId, key) {
  const paths = [
    "get_signed_url",
    "get-signed-url",
  ]
  let lastError = null

  for (const path of paths) {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/${path}?agent_id=${encodeURIComponent(agentId)}`,
      {headers: {"xi-api-key": key}},
    )
    if (res.ok) {
      const data = await res.json()
      if (!data.signed_url) {
        throw new Error("get_signed_url response missing signed_url")
      }
      return data.signed_url
    }
    lastError = new Error(`get_signed_url failed (${res.status}): ${await res.text().catch(() => "")}`)
  }

  throw lastError
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${port}`)
  res.setHeader("access-control-allow-origin", "*")
  res.setHeader("access-control-allow-methods", "GET, OPTIONS")
  res.setHeader("access-control-allow-headers", "content-type")

  if (req.method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }

  if (url.pathname === "/health") {
    res.writeHead(200, {"content-type": "application/json"})
    res.end(JSON.stringify({ok: true}))
    return
  }

  if (url.pathname !== "/signed-url") {
    res.writeHead(404, {"content-type": "text/plain"})
    res.end("not found")
    return
  }

  try {
    const agentId = url.searchParams.get("agent_id") || defaultAgentId
    const signedUrl = await fetchSignedUrl(agentId, apiKey)
    res.writeHead(200, {"content-type": "application/json"})
    res.end(JSON.stringify({signed_url: signedUrl}))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.writeHead(502, {"content-type": "text/plain"})
    res.end(message)
  }
})

server.listen(port, "127.0.0.1", () => {
  console.log(`ElevenLabs signing server listening at http://127.0.0.1:${port}`)
})
