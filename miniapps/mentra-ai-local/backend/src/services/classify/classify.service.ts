/**
 * Visual-query classifier service — server-side.
 *
 * Ported from the miniapp's agent/visual-classifier.ts. A fast (~200-300ms)
 * call that decides whether a query needs the camera photo to answer. Runs the
 * default (cheap/fast) model through OpenRouter — it's a text-only yes/no, so
 * it doesn't depend on the user's chosen agent model. Returns false on error
 * (defaults to the fast / non-visual path).
 */

import {hasLLMKey, DEFAULT_LLM_MODEL} from "../ai-config"
import {callOpenRouter} from "../openrouter"

const SYSTEM_PROMPT = `You classify queries from a user wearing smart glasses with a camera. The camera sees whatever the user is looking at.
Answer ONLY "yes" or "no".
Would a photo of what the user sees help answer this query?
Say yes if: the user is looking at something physical and the photo would help identify it, read it, describe it, or inspect it. This includes looking at objects, products, signs, food, people, buildings, animals, labels, scenes, or asking what's around them. Also yes if the user asks you to see, look at, or compare visible things.
Say no if: the answer comes purely from non-visual senses (smell, sound), general knowledge, abstract topics, spelling/definitions, or the user is asking about a place/area in general terms (safety, reviews, policies, language) where the photo wouldn't add useful information.
IMPORTANT — Say no for figurative/idiomatic language where visual words are used non-literally. These are NOT about seeing something physical:
- "I see" / "I can see why" = I understand
- "look into" / "look up" = research
- "check this out" / "check out" = pay attention
- "looks like" = seems/appears ("that looks like a good deal", "it looks like rain")
- "keep an eye on" = monitor
- "let me see" = let me think/consider
- "how do I look?" = asking about own appearance (camera can't see user)
- "looking at" in terms of price/numbers = considering/evaluating
- "is this the right X?" where X is an address/info = verifying data, not visual
yes: "what is this?", "read that sign", "translate this text", "is that a good restaurant?" (looking at it), "how much does it cost?" (looking at product), "are those shoes on sale?", "what can you see?", "anything interesting around here?", "which one is better?" (comparing visible items)
no: "where am I?", "what time is it?", "what's that smell?", "check this out", "I can see why that's popular", "can you look into that?", "that looks like a good deal", "how do I look?", "keep an eye on that", "let me see the options", "I see"`

/** Classify whether a query requires visual context (photo from camera). */
export async function isVisualQuery(query: string): Promise<boolean> {
  if (!hasLLMKey) return false
  try {
    const message = await callOpenRouter({
      model: DEFAULT_LLM_MODEL,
      messages: [
        {role: "system", content: SYSTEM_PROMPT},
        {role: "user", content: query},
      ],
      temperature: 0,
      maxTokens: 3,
    })

    const text = (message.content ?? "").trim().toLowerCase()
    return text.startsWith("yes")
  } catch (error) {
    console.warn("Visual classifier failed, defaulting to non-visual:", error)
    return false
  }
}
