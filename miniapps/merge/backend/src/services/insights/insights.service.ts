export type FrequencyMode = "low" | "medium" | "high"
export type AnalysisTrigger = "final" | "sentence" | "interval" | "expand"
export type DisplayAction = "show" | "replace" | "queue" | "drop"

export interface InsightSource {
  title: string
  uri: string
  domain?: string
}

export interface InsightProfiling {
  totalMs: number
  geminiMs?: number
  parseMs?: number
  model: string
  webSearchEnabled: boolean
  grounded: boolean
  sourceCount: number
}

export interface InsightRequest {
  userId?: string
  frequency?: FrequencyMode
  settings?: {
    answerLanguage?: string
  }
  interaction?: {
    type: "expand"
    insight: {
      id?: string
      text?: string
      agentType?: string
      sources?: InsightSource[]
    }
    requestedAt?: number
  }
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
    isFinal?: boolean
    isInterim?: boolean
    canDefer?: boolean
  }
  utterance?: {
    id?: string
    text?: string
    fullText?: string
    isFinal?: boolean
    language?: string | null
    timestamp?: number
  }
  history?: {
    transcripts?: string[]
    conversation?: Array<{
      id?: string
      text?: string
      isFinal?: boolean
      language?: string | null
      timestamp?: number
    }>
    insights?: string[]
    activeInsight?: {
      text?: string
      ageMs?: number
    } | null
  }
}

export interface InsightResponse {
  type: "silent" | "defer" | "insight"
  text?: string
  agentType?: string
  reasoning?: string
  displayAction?: DisplayAction
  urgency?: "low" | "medium" | "high"
  confidence?: number
  sources?: InsightSource[]
  searchQueries?: string[]
  profiling?: InsightProfiling
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
    const startedAt = nowMs()
    const isExpansion = body.interaction?.type === "expand"
    const text = (body.interaction?.insight.text ?? body.analysis?.chunkText ?? body.utterance?.text ?? "").trim()
    if (text.length < 12) {
      if (canDefer(body)) {
        return withProfiling(
          {type: "defer", reasoning: "Waiting for more words before deciding", confidence: 0.2, urgency: "low"},
          profileResult({startedAt, model: this.model, webSearchEnabled: this.webSearchEnabled}),
        )
      }
      return withProfiling(
        {type: "silent", reasoning: "Utterance too short"},
        profileResult({startedAt, model: this.model, webSearchEnabled: this.webSearchEnabled}),
      )
    }

    const priorTranscripts = priorContext(body, text)
    if (!isExpansion && isContextSensitiveWorkstream(text) && priorTranscripts.length < 2) {
      return withProfiling(
        {type: "silent", reasoning: "Needs more grounded project context"},
        profileResult({startedAt, model: this.model, webSearchEnabled: this.webSearchEnabled}),
      )
    }

    const apiKey = this.apiKey
    if (!apiKey) {
      if (this.allowMock) {
        return withProfiling(
          mockInsight(text),
          profileResult({startedAt, model: this.model, webSearchEnabled: this.webSearchEnabled}),
        )
      }
      throw new InsightServiceError("GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY is required", 503)
    }

    const geminiStartedAt = nowMs()
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
            parts: [
              {
                text: mergeInstructions(body.frequency ?? "medium", body.settings?.answerLanguage, isExpansion),
              },
            ],
          },
          contents: [
            {
              role: "user",
              parts: [{text: buildPrompt(body)}],
            },
          ],
          generationConfig: {
            maxOutputTokens: isExpansion ? 768 : 512,
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
    const geminiMs = elapsedMs(geminiStartedAt)

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      throw new InsightServiceError(`Gemini ${response.status}: ${errorText.slice(0, 240)}`, 500)
    }

    const parseStartedAt = nowMs()
    const data = (await response.json()) as Record<string, unknown>
    const output = extractOutputText(data)
    const parsed = parseInsightOutput(output)
    const grounding = extractGrounding(data)
    const parseMs = elapsedMs(parseStartedAt)
    parsed.sources = grounding.sources
    parsed.searchQueries = grounding.searchQueries
    parsed.profiling = profileResult({
      startedAt,
      geminiMs,
      parseMs,
      model: this.model,
      webSearchEnabled: this.webSearchEnabled,
      grounded: grounding.sources.length > 0,
      sourceCount: grounding.sources.length,
    })
    console.info("[LocalMerge] insight profiling", {
      type: parsed.type,
      totalMs: parsed.profiling.totalMs,
      geminiMs: parsed.profiling.geminiMs,
      parseMs: parsed.profiling.parseMs,
      model: parsed.profiling.model,
      webSearchEnabled: parsed.profiling.webSearchEnabled,
      grounded: parsed.profiling.grounded,
      sourceCount: parsed.profiling.sourceCount,
    })
    if (parsed.type === "insight" && parsed.text) {
      parsed.text = parsed.text.trim().slice(0, isExpansion ? 320 : 180)
      parsed.displayAction = isExpansion ? "replace" : (parsed.displayAction ?? "show")
    }
    return parsed
  }
}

export const insightsService = new InsightsService()

export function mergeInstructions(frequency: FrequencyMode, answerLanguage = "English", isExpansion = false): string {
  const frequencyRule =
    frequency === "high"
      ? "High frequency: offer useful definitions, corrections, and non-obvious context whenever it truly adds value."
      : frequency === "low"
        ? "Low frequency: stay silent unless the insight prevents confusion, corrects a serious false claim, or defines a term needed to follow the conversation."
        : "Medium frequency: be selective. Prefer core-topic clarifications, non-obvious tradeoffs, and useful definitions."

  const taskRule = isExpansion
    ? `The user explicitly swiped for more detail about the displayed insight. Expand it with two or three concrete, useful details, an explanation, or relevant context. Do not merely restate the original. Prefer an insight response; stay silent only when adding detail would require guessing or unsupported private context. Keep the expanded text under 320 characters and set displayAction to replace.`
    : `Your job is to silently listen to conversation snippets and decide whether to surface one short insight.
${frequencyRule}`

  return `You are Merge, a proactive conversation intelligence assistant for smart glasses.

System context:
- You run in a smart-glasses miniapp. The user sees brief text insights while listening to real-world conversation.
- Speech arrives from streaming transcription. Some requests are final utterances, but many are interim fragments that may be incomplete, revised, or missing the next few words.
- The prompt includes the latest analyzed chunk, the full current utterance when available, recent transcript history, prior insights already shown, and the currently displayed insight.

${taskRule}

Rules:
- ${isExpansion ? "Honor the explicit request for more detail when useful and grounded." : "Usually remain silent."}
- Never summarize or rephrase what was just said.
- Use the user's timezone and local time from the prompt for every date or time answer. Do not infer "today" or "tomorrow" from server time.
- Only speak when adding new, useful information that is grounded in the recent transcript alone or, when web search is enabled, grounded by search for public factual/current information: a definition, correction, caveat, surprising constraint, concrete alternative, or direct answer to an information-seeking question.
- If a question asks for current, live, recent, local, price, weather, sports, news, or other time-sensitive public facts and webSearchEnabled is true, use Google Search grounding. If you cannot ground that answer, return silent with the reason.
- If webSearchEnabled is false and the answer requires current/public lookup, return silent and say web search is disabled.
- Stay silent if the conversation references a specific codebase, project, document, person, meeting, company, or private situation that is not actually present in the recent transcript.
- Do not guess project-specific or domain-specific answers from generic words. If you would need hidden context, repository access, private docs, or facts not stated in the transcript, return silent.
- For software, infrastructure, debugging, deployment, or implementation discussions, require several grounded prior transcript turns before giving tactical advice.
- Keep user-facing insight text concise and glasses-friendly, ${isExpansion ? "under 320 characters." : "ideally under 80 characters."}
- Write insight text as plain natural language only. Never emit Markdown, brackets, XML/SSML tags, or speech-synthesis instructions. Spell out a symbol when its pronunciation matters.
- When directly answering a question, include a tiny subject cue from the question so the user knows what the answer refers to after other dialog. Use 1-4 words before a colon when helpful, like "Sky color:" or "Date:"; do not repeat the full question.
- Understand conversation in any language. Write every user-facing insight in ${answerLanguage === "Auto" ? "the user's apparent preferred language from the conversation" : answerLanguage}. Do not switch output language just because another speaker uses a different language.
- Avoid duplicate insights already shown.
- If analysis.isInterim is true and the snippet looks like an unfinished question, unfinished claim, clause ending mid-thought, or topic that needs the next few words to avoid a wrong answer, return defer.
- Use defer when more near-term speech is likely to make a useful answer possible. Use silent when the snippet is complete enough to know no insight is needed.
- Do not defer final utterances just to be cautious. For final utterances, choose insight when useful or silent/drop when not useful.
- displayAction means:
  - show: normal new insight.
  - replace: urgent correction or direct answer that should interrupt the current displayed insight.
  - queue: useful but not urgent; okay to show after the current insight.
  - drop: candidate is not worth showing.
- Frequency controls strictness: low should usually return silent or drop; high may show more definitions and answers.

Return only JSON:
{"type":"silent","reasoning":"...","confidence":0.0,"urgency":"low|medium|high"}
or
{"type":"defer","reasoning":"...","confidence":0.0,"urgency":"low|medium|high"}
or
{"type":"insight","text":"...","agentType":"Initial|Definer|FactChecker|QuestionAnswerer|FollowUp","displayAction":"show|replace|queue|drop","urgency":"low|medium|high","confidence":0.0,"reasoning":"..."}`
}

export function buildPrompt(body: InsightRequest): string {
  const transcripts = body.history?.transcripts?.slice(-10) ?? []
  const conversation = body.history?.conversation?.slice(-10) ?? []
  const insights = body.history?.insights?.slice(-8) ?? []
  const utterance = (body.analysis?.chunkText ?? body.utterance?.text ?? "").trim()
  const fullUtterance = (body.utterance?.fullText ?? body.utterance?.text ?? utterance).trim()
  const language = body.utterance?.language ?? "auto"
  const isFinal = body.analysis?.isFinal ?? body.utterance?.isFinal ?? (body.analysis?.trigger === "final")
  const isInterim = body.analysis?.isInterim ?? !isFinal

  return JSON.stringify(
    {
      currentUtcTime: new Date().toISOString(),
      userLocalTime: body.analysis?.localTime ?? null,
      userTimezone: body.analysis?.timezone ?? null,
      userTimezoneOffsetMinutes: body.analysis?.timezoneOffsetMinutes ?? null,
      userLocale: body.analysis?.locale ?? null,
      answerLanguage: body.settings?.answerLanguage ?? "English",
      language,
      analysisTrigger: body.analysis?.trigger ?? "final",
      analysisIsFinal: isFinal,
      analysisIsInterim: isInterim,
      canDefer: body.analysis?.canDefer ?? isInterim,
      pendingChunkCount: body.analysis?.pendingChunkCount ?? 1,
      latestConversationChunk: utterance,
      fullCurrentUtterance: fullUtterance,
      recentTranscripts: transcripts,
      recentConversation: conversation,
      recentInsightsAlreadyShown: insights,
      currentInsightOnDisplay: body.history?.activeInsight ?? null,
      interaction: body.interaction ?? null,
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

function extractGrounding(data: Record<string, unknown>): {sources: InsightSource[]; searchQueries: string[]} {
  const candidates = Array.isArray(data.candidates) ? data.candidates : []
  const candidate = candidates[0] as {groundingMetadata?: unknown} | undefined
  const metadata = candidate?.groundingMetadata as
    | {
        webSearchQueries?: unknown
        groundingChunks?: unknown
      }
    | undefined

  const searchQueries = Array.isArray(metadata?.webSearchQueries)
    ? metadata.webSearchQueries.filter((query): query is string => typeof query === "string" && query.trim().length > 0)
    : []

  const seen = new Set<string>()
  const sources: InsightSource[] = []
  const chunks = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks : []
  for (const chunk of chunks) {
    const web = (chunk as {web?: unknown}).web as {uri?: unknown; title?: unknown} | undefined
    const uri = typeof web?.uri === "string" ? web.uri : ""
    if (!uri || seen.has(uri)) continue
    seen.add(uri)
    const title = typeof web?.title === "string" && web.title.trim() ? web.title.trim() : domainFromUrl(uri) ?? "Source"
    sources.push({
      title,
      uri,
      domain: domainFromUrl(uri),
    })
    if (sources.length >= 5) break
  }

  return {sources, searchQueries}
}

function parseInsightOutput(output: string): InsightResponse {
  try {
    const parsed = JSON.parse(stripCodeFence(output)) as InsightResponse
    if (parsed.type === "insight" && parsed.text) return parsed
    if (parsed.type === "defer") {
      return {
        type: "defer",
        reasoning: parsed.reasoning ?? "Waiting for more context",
        confidence: parsed.confidence,
        urgency: parsed.urgency,
      }
    }
    return {type: "silent", reasoning: parsed.reasoning ?? "Model stayed silent"}
  } catch {
    return {type: "silent", reasoning: "Model returned invalid JSON"}
  }
}

function stripCodeFence(value: string): string {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
}

function canDefer(body: InsightRequest): boolean {
  return body.analysis?.canDefer === true || body.analysis?.isInterim === true || body.utterance?.isFinal === false
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now()
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(nowMs() - startedAt))
}

function withProfiling(response: InsightResponse, profiling: InsightProfiling): InsightResponse {
  return {
    ...response,
    sources: response.sources ?? [],
    searchQueries: response.searchQueries ?? [],
    profiling,
  }
}

function profileResult(input: {
  startedAt: number
  geminiMs?: number
  parseMs?: number
  model: string
  webSearchEnabled: boolean
  grounded?: boolean
  sourceCount?: number
}): InsightProfiling {
  return {
    totalMs: elapsedMs(input.startedAt),
    geminiMs: input.geminiMs,
    parseMs: input.parseMs,
    model: input.model,
    webSearchEnabled: input.webSearchEnabled,
    grounded: input.grounded ?? false,
    sourceCount: input.sourceCount ?? 0,
  }
}

function domainFromUrl(uri: string): string | undefined {
  try {
    return new URL(uri).hostname.replace(/^www\./, "")
  } catch {
    return undefined
  }
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
