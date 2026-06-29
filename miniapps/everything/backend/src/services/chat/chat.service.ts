import Anthropic from "@anthropic-ai/sdk"

export type ChatRole = "user" | "assistant"

export interface ChatTurn {
  role: ChatRole
  text: string
}

export interface ChatRequest {
  userId?: string
  messages?: ChatTurn[]
}

export interface ChatResponse {
  text: string
  /** Base64-encoded PNG (no data: prefix) when the model rendered a chart/image. */
  imageBase64: string | null
}

export class ChatServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 500 | 503,
  ) {
    super(message)
    this.name = "ChatServiceError"
  }
}

const FILES_BETA = "files-api-2025-04-14"
const CODE_EXECUTION_BETA = "code-execution-2025-08-25"
const MAX_PAUSE_CONTINUATIONS = 5

const SYSTEM_PROMPT = `You are Everything, a concise conversational assistant for smart glasses.

- Answer directly and briefly — the user reads your text on a small heads-up display, so keep prose to 1-3 short sentences.
- A reasonable estimate is always acceptable. Prefer giving your best-effort answer over withholding one. Do not ask a follow-up or clarifying question unless it is genuinely impossible to give a useful answer without it — assume sensible defaults and proceed.
- When the request benefits from a visual (a chart, graph, trend, comparison, or "show me ..." over numeric/time-series data such as a weather forecast), USE the code_execution tool to generate the figure as a PNG with matplotlib (matplotlib, numpy, pandas, and pillow are pre-installed).
- CRITICAL: the figure MUST be exactly 200x100 pixels, because it is shown on a tiny monochrome heads-up display. Create it with figsize=(2.0, 1.0) and dpi=100, and save with plt.savefig("chart.png", dpi=100) — do NOT use bbox_inches="tight" (it changes the pixel size). Verify the saved PNG is 200x100 (e.g. with pillow) and re-save if not.
- Because it is so small and high-contrast: use large fonts (~7-8pt), thick lines/markers, no chart title, at most 3-5 axis ticks per axis, short labels, and tight margins (plt.tight_layout(pad=0.2)). Avoid thin gridlines and legends unless essential. Favor a single clear series.
- COLORS ARE INVERTED on this display: black is transparent and white is lit. So draw everything in WHITE on a BLACK background — set the figure and axes facecolor to black ("#000000"), and make all lines, markers, text, ticks, axis labels, and spines white ("#FFFFFF"). Do not produce a white/light background; anything black will be invisible (transparent) on the glasses.
- When you need current or real-world data (weather, prices, scores, news), use the web_search tool to fetch it before charting. Do not invent data.
- After producing a chart, add a one or two sentence text summary of what it shows. Do not describe the chart in long prose.
- If no visual is warranted, just answer in text.`

class ChatService {
  readonly model = process.env.EVERYTHING_MODEL ?? "claude-opus-4-8"

  private get apiKey(): string | undefined {
    return process.env.ANTHROPIC_API_KEY
  }

  private client: Anthropic | null = null

  private getClient(): Anthropic {
    if (!this.apiKey) {
      throw new ChatServiceError("ANTHROPIC_API_KEY is required", 503)
    }
    if (!this.client) {
      this.client = new Anthropic({apiKey: this.apiKey})
    }
    return this.client
  }

  async respond(body: ChatRequest): Promise<ChatResponse> {
    const turns = (body.messages ?? []).filter((t) => t.text && t.text.trim())
    if (turns.length === 0) {
      throw new ChatServiceError("No messages provided", 400)
    }

    const client = this.getClient()
    const messages: Anthropic.Beta.BetaMessageParam[] = turns.map((t) => ({
      role: t.role,
      content: t.text.trim(),
    }))

    let response = await this.create(client, messages)

    // Server-side tools (code_execution, web_search) run a sampling loop that can
    // pause; re-send to let the server resume until it finishes the turn.
    let continuations = 0
    while (response.stop_reason === "pause_turn" && continuations < MAX_PAUSE_CONTINUATIONS) {
      messages.push({role: "assistant", content: response.content})
      response = await this.create(client, messages)
      continuations += 1
    }

    const text = extractText(response) || "(no response)"
    const imageBase64 = await this.firstImageBase64(client, response)

    return {text, imageBase64}
  }

  private async create(
    client: Anthropic,
    messages: Anthropic.Beta.BetaMessageParam[],
  ): Promise<Anthropic.Beta.BetaMessage> {
    try {
      return await client.beta.messages.create({
        model: this.model,
        max_tokens: 8000,
        betas: [CODE_EXECUTION_BETA, FILES_BETA],
        system: SYSTEM_PROMPT,
        // Use the basic web_search variant: web_search_20260209 has built-in
        // dynamic filtering that auto-injects its own `code_execution` tool,
        // which collides with the explicit code_execution we declare for charts
        // ("Auto-injecting tools would conflict with existing tool names").
        tools: [
          {type: "code_execution_20250825", name: "code_execution"},
          {type: "web_search_20250305", name: "web_search"},
        ],
        messages,
      })
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        throw new ChatServiceError("ANTHROPIC_API_KEY is invalid", 503)
      }
      const message = error instanceof Error ? error.message : "Claude request failed"
      throw new ChatServiceError(message, 500)
    }
  }

  /**
   * Download the first image the model wrote during code execution and return it
   * as base64, or null if it produced no image. Code-execution output files live
   * inside bash_code_execution_tool_result blocks as opaque file ids; we confirm
   * each is an image via its file metadata before downloading.
   */
  private async firstImageBase64(
    client: Anthropic,
    message: Anthropic.Beta.BetaMessage,
  ): Promise<string | null> {
    for (const fileId of generatedFileIds(message)) {
      try {
        const meta = await client.beta.files.retrieveMetadata(fileId, {betas: [FILES_BETA]})
        if (!/\.(png|jpe?g)$/i.test(meta.filename)) continue
        const resp = await client.beta.files.download(fileId, {betas: [FILES_BETA]})
        return Buffer.from(await resp.arrayBuffer()).toString("base64")
      } catch (err) {
        console.warn("[Everything] failed to fetch generated file", fileId, err)
      }
    }
    return null
  }
}

export const chatService = new ChatService()

/** Concatenate the assistant's top-level text blocks. */
function extractText(message: Anthropic.Beta.BetaMessage): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text)
    }
  }
  return parts.join("\n").trim()
}

/** Collect file ids written by code execution, newest blocks last. */
function generatedFileIds(message: Anthropic.Beta.BetaMessage): string[] {
  const ids: string[] = []
  for (const block of message.content) {
    if (block.type !== "bash_code_execution_tool_result") continue
    const result = block.content
    if (result.type !== "bash_code_execution_result") continue
    for (const output of result.content) {
      if (output.file_id) ids.push(output.file_id)
    }
  }
  return ids
}
