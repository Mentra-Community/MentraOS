export type FrequencyMode = "low" | "medium" | "high"
export type AnalysisTrigger = "final" | "sentence" | "interval"
export type DisplayAction = "show" | "replace" | "queue" | "drop"

export interface InsightRequest {
  userId?: string
  frequency?: FrequencyMode
  analysis?: {
    id?: string
    trigger?: AnalysisTrigger
    chunkText?: string
    chunkStartedAt?: number
    chunkEndedAt?: number
    timezone?: string
    timezoneOffsetMinutes?: number
    locale?: string
    localTime?: string
    pendingChunkCount?: number
  }
  utterance?: {
    id?: string
    text?: string
    language?: string | null
    timestamp?: number
  }
  history?: {
    transcripts?: string[]
    insights?: string[]
    activeInsight?: {
      text?: string
      ageMs?: number
    } | null
  }
}

export interface InsightResponse {
  type: "silent" | "insight"
  text?: string
  agentType?: string
  reasoning?: string
  displayAction?: DisplayAction
  urgency?: "low" | "medium" | "high"
  confidence?: number
}

export class InsightServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 500 | 503,
  ) {
    super(message)
    this.name = "InsightServiceError"
  }
}

class InsightsService {
  readonly model = process.env.GEMINI_MODEL ?? process.env.LLM_MODEL ?? "gemini-3.5-flash"

  private get allowMock(): boolean {
    return process.env.MERGE_ALLOW_MOCK_INSIGHTS === "true"
  }

  private get webSearchEnabled(): boolean {
    return process.env.MERGE_ENABLE_WEB_SEARCH === "true"
  }

  private get apiKey(): string | undefined {
    return (
      process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
      process.env.GOOGLE_API_KEY ??
      process.env.GEMENI_API_KEY
    )
  }

  async createInsight(body: InsightRequest): Promise<InsightResponse> {
    const text = (body.analysis?.chunkText ?? body.utterance?.text ?? "").trim()
    if (text.length < 12) {
      return {type: "silent", reasoning: "Utterance too short"}
    }

    const priorTranscripts = priorContext(body, text)
    if (isContextSensitiveWorkstream(text) && priorTranscripts.length < 2) {
      return {type: "silent", reasoning: "Needs more grounded project context"}
    }

    const apiKey = this.apiKey
    if (!apiKey) {
      if (this.allowMock) {
        return mockInsight(text)
      }
      throw new InsightServiceError("GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY is required", 503)
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{text: mergeInstructions(body.frequency ?? "medium")}],
          },
          contents: [
            {
              role: "user",
              parts: [{text: buildPrompt(body)}],
            },
          ],
          generationConfig: {
            maxOutputTokens: 512,
            temperature: 0.3,
            responseMimeType: "application/json",
            thinkingConfig: {
              thinkingBudget: 0,
            },
          },
          ...(this.webSearchEnabled ? {tools: [{google_search: {}}]} : {}),
        }),
      },
    )

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      throw new InsightServiceError(`Gemini ${response.status}: ${errorText.slice(0, 240)}`, 500)
    }

    const data = (await response.json()) as Record<string, unknown>
    const output = extractOutputText(data)
    const parsed = parseInsightOutput(output)
    if (parsed.type === "insight" && parsed.text) {
      parsed.text = parsed.text.trim().slice(0, 180)
      parsed.displayAction = parsed.displayAction ?? "show"
    }
    return parsed
  }
}

export const insightsService = new InsightsService()

function mergeInstructions(frequency: FrequencyMode): string {
  const frequencyRule =
    frequency === "high"
      ? "High frequency: offer useful definitions, corrections, and non-obvious context whenever it truly adds value."
      : frequency === "low"
        ? "Low frequency: stay silent unless the insight prevents confusion, corrects a serious false claim, or defines a term needed to follow the conversation."
        : "Medium frequency: be selective. Prefer core-topic clarifications, non-obvious tradeoffs, and useful definitions."

  return `You are Merge, a proactive conversation intelligence assistant for smart glasses.

Your job is to silently listen to conversation snippets and decide whether to surface one short insight.
${frequencyRule}

Rules:
- Usually remain silent.
- Never summarize or rephrase what was just said.
- Use the user's timezone and local time from the prompt for every date or time answer. Do not infer "today" or "tomorrow" from server time.
- Only speak when adding new, useful information that is grounded in the recent transcript alone or, when web search is enabled, grounded by search for public factual/current information: a definition, correction, caveat, surprising constraint, concrete alternative, or direct answer to an information-seeking question.
- Stay silent if the conversation references a specific codebase, project, document, person, meeting, company, or private situation that is not actually present in the recent transcript.
- Do not guess project-specific or domain-specific answers from generic words. If you would need hidden context, repository access, private docs, or facts not stated in the transcript, return silent.
- For software, infrastructure, debugging, deployment, or implementation discussions, require several grounded prior transcript turns before giving tactical advice.
- Keep user-facing insight text concise and glasses-friendly, ideally under 80 characters.
- When directly answering a question, include a tiny subject cue from the question so the user knows what the answer refers to after other dialog. Use 1-4 words before a colon when helpful, like "Sky color:" or "Date:"; do not repeat the full question.
- Match the conversation language.
- Avoid duplicate insights already shown.
- displayAction means:
  - show: normal new insight.
  - replace: urgent correction or direct answer that should interrupt the current displayed insight.
  - queue: useful but not urgent; okay to show after the current insight.
  - drop: candidate is not worth showing.
- Frequency controls strictness: low should usually return silent or drop; high may show more definitions and answers.

Return only JSON:
{"type":"silent","reasoning":"...","confidence":0.0,"urgency":"low|medium|high"}
or
{"type":"insight","text":"...","agentType":"Initial|Definer|FactChecker|QuestionAnswerer","displayAction":"show|replace|queue|drop","urgency":"low|medium|high","confidence":0.0,"reasoning":"..."}`
}

function buildPrompt(body: InsightRequest): string {
  const transcripts = body.history?.transcripts?.slice(-10) ?? []
  const insights = body.history?.insights?.slice(-8) ?? []
  const utterance = (body.analysis?.chunkText ?? body.utterance?.text ?? "").trim()
  const language = body.utterance?.language ?? "auto"

  return JSON.stringify(
    {
      currentUtcTime: new Date().toISOString(),
      userLocalTime: body.analysis?.localTime ?? null,
      userTimezone: body.analysis?.timezone ?? null,
      userTimezoneOffsetMinutes: body.analysis?.timezoneOffsetMinutes ?? null,
      userLocale: body.analysis?.locale ?? null,
      language,
      analysisTrigger: body.analysis?.trigger ?? "final",
      pendingChunkCount: body.analysis?.pendingChunkCount ?? 1,
      latestConversationChunk: utterance,
      recentTranscripts: transcripts,
      recentInsightsAlreadyShown: insights,
      currentInsightOnDisplay: body.history?.activeInsight ?? null,
      webSearchEnabled: process.env.MERGE_ENABLE_WEB_SEARCH === "true",
    },
    null,
    2,
  )
}

function priorContext(body: InsightRequest, latestText: string): string[] {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase()
  const latest = normalize(latestText)
  return (body.history?.transcripts ?? [])
    .map((text) => text.trim())
    .filter((text) => text.length > 0 && normalize(text) !== latest)
}

function isContextSensitiveWorkstream(text: string): boolean {
  return /\b(api|backend|branch|build|ci|client|cloud|codebase|commit|debug(?:ging)?|deploy(?:ment)?|docker|endpoint|e2e|github|implementation|kubernetes|merge conflict|pod|porter|pr|pull request|reconnect(?:ion)?|repo|runtime|server|service|test harness|udp|websocket|workflow)\b/i.test(
    text,
  )
}

function extractOutputText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string") return data.output_text

  const candidates = Array.isArray(data.candidates) ? data.candidates : []
  const candidateParts: string[] = []
  for (const candidate of candidates) {
    const content = (candidate as {content?: unknown}).content
    const parts = (content as {parts?: unknown} | undefined)?.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      const text = (part as {text?: unknown}).text
      if (typeof text === "string") candidateParts.push(text)
    }
  }
  if (candidateParts.length > 0) return candidateParts.join("\n").trim()

  const output = Array.isArray(data.output) ? data.output : []
  const parts: string[] = []
  for (const item of output) {
    const content = (item as {content?: unknown}).content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      const text = (c as {text?: unknown; type?: unknown}).text
      if (typeof text === "string") parts.push(text)
    }
  }
  return parts.join("\n").trim()
}

function parseInsightOutput(output: string): InsightResponse {
  try {
    const parsed = JSON.parse(stripCodeFence(output)) as InsightResponse
    if (parsed.type === "insight" && parsed.text) return parsed
    return {type: "silent", reasoning: parsed.reasoning ?? "Model stayed silent"}
  } catch {
    return {type: "silent", reasoning: "Model returned invalid JSON"}
  }
}

function stripCodeFence(value: string): string {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
}

function mockInsight(text: string): InsightResponse {
  const firstWords = text.split(/\s+/).slice(0, 5).join(" ")
  return {
    type: "insight",
    text: `Worth checking: ${firstWords}...`,
    agentType: "Initial",
    reasoning: "Mock insight because MERGE_ALLOW_MOCK_INSIGHTS=true",
  }
}
