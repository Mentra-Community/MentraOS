/**
 * Wake Word Detection for Mentra AI
 *
 * Detects "Hey Mentra" wake word activation in transcription text.
 */

/**
 * Wake words that trigger Mentra AI activation.
 * Each entry is matched flexibly — optional whitespace between letters within
 * a word, and required whitespace between words — so Deepgram variants like
 * "hey mentr a" or "hey  mentra" still match.
 */
export const WAKE_WORDS = [
  "hey mentra",
  "hey mantra",
  "hey mintra",
  "hey muntra",

  "hi mentra",
  "hi mantra",
  "hi mintra",
  "hi muntra",

  "ok mentra",
  "ok mantra",
  "ok mintra",
  "ok muntra",

  "okay mentra",
  "okay mantra",
  "okay mintra",
  "okay muntra",

  "hello mentra",
  "hello mantra",
  "hello mintra",
  "hello muntra",


];

/**
 * Pre-built regex patterns for each wake word.
 * Allows optional whitespace between consecutive letters within the same word
 * so that Deepgram transcription variants like "hey mentr a" still match.
 */
const WAKE_PATTERNS: RegExp[] = WAKE_WORDS.map((ww) => {
  let pattern = '';
  for (let i = 0; i < ww.length; i++) {
    const ch = ww[i];
    if (ch === ' ') {
      // Word boundary — allow optional punctuation (comma, period) + whitespace
      pattern += '[,.!?;:\\s]*\\s+';
    } else {
      pattern += ch;
      // Between consecutive letters in the same word, allow optional whitespace
      const next = ww[i + 1];
      if (next && next !== ' ') {
        pattern += '\\s*';
      }
    }
  }
  return new RegExp(pattern, 'i');
});

/**
 * Vision keywords that indicate a query requires camera/image analysis
 */
export const VISION_KEYWORDS = [
  // General identification
  'what am i looking at', 'what is this', 'what is that',
  'identify this', 'identify that', 'what do you see', 'describe what',
  'tell me about this', 'tell me about that', 'what\'s in front of me',
  'can you see', 'look at this', 'look at that', 'check this out',
  'what\'s this', 'what\'s that', 'whats this', 'whats that',
  'what kind of', 'what type of', 'what brand', 'what model',
  'who is this', 'who is that', 'who\'s this', 'who\'s that',

  // Reading / OCR
  'read this', 'read that', 'read it', 'what does this say',
  'what does that say', 'what does it say', 'what is written',
  'can you read', 'read the text', 'read the sign', 'read the label',
  'what\'s written', 'whats written', 'translate this', 'translate that',

  // Counting / Colors / Quantities
  'what color', 'what colour', 'how many', 'how much',
  'count the', 'count how many', 'how big', 'how small',
  'how tall', 'how long', 'how wide', 'what size',

  // Description
  'describe this', 'describe that', 'describe what you see',
  'tell me what you see', 'explain what you see',
  'what do you notice', 'what can you tell me about',

  // Problem solving (implies looking at something)
  'solve this', 'fix this', 'what\'s wrong', 'whats wrong',
  'what is wrong', 'how do i fix', 'how do i solve', 'how can i fix',
  'help me fix', 'help me solve', 'help me with this',
  'what\'s the problem', 'whats the problem', 'what is the problem',
  'diagnose this', 'troubleshoot this', 'debug this',
  'why isn\'t this working', 'why isnt this working',
  'why is this broken', 'why doesn\'t this work', 'why doesnt this work',
  'this isn\'t working', 'this isnt working', 'this doesn\'t work',
  'not working', 'broken', 'stuck', 'jammed',
  'what should i do', 'what do i do', 'how do i repair',

  // Instructions (implies looking at something)
  'how do i use this', 'how do i use that', 'how does this work',
  'how does that work', 'show me how', 'teach me how',
  'how to use this', 'how to use that', 'what does this do',
  'what does that do', 'how do i operate', 'how to operate',
  'how do i turn this on', 'how do i turn this off',
  'how do i set this up', 'how to set up', 'where do i',
  'which button', 'what button', 'where is the', 'how do i connect',
  'guide me', 'walk me through', 'step by step',

  // Location / Spatial
  'where is this', 'where is that',
  'what place is this', 'what building', 'what store',
  'what restaurant', 'what street'
];

/**
 * Result of wake word detection
 */
export interface WakeWordResult {
  detected: boolean;
  query: string;  // The query text after removing the wake word
  wakeWordUsed?: string;  // Which wake word was detected
}

/**
 * Detect if the text contains a wake word
 * @param text - The transcription text to check
 * @returns Detection result with the query text
 */
export function detectWakeWord(text: string): WakeWordResult {
  const lowerText = text.toLowerCase().trim();

  for (let i = 0; i < WAKE_PATTERNS.length; i++) {
    const match = lowerText.match(WAKE_PATTERNS[i]);
    if (match && match.index !== undefined) {
      // Extract everything after the matched wake word, stripping leading punctuation
      let query = text.slice(match.index + match[0].length).trim();
      // Remove leading punctuation (comma, period, etc.)
      query = query.replace(/^[,.\s]+/, '').trim();
      return {
        detected: true,
        query,
        wakeWordUsed: WAKE_WORDS[i],
      };
    }
  }

  return {
    detected: false,
    query: text.trim(),
  };
}

/**
 * Trailing fragments of wake words that Deepgram may split into a separate
 * utterance. For "hey mentra", Deepgram might send "hey mentr" in one
 * utterance and "a, what time is it?" in the next — leaving "a," as residue.
 *
 * We generate all suffixes of the last word ("mentra") that are 1-5 chars,
 * so: "a", "ra", "tra", "ntra", "entra". These are stripped (with optional
 * trailing punctuation) from the START of text when it immediately follows
 * a wake word detection.
 */
const WAKE_WORD_TRAILING_FRAGMENTS: RegExp = (() => {
  const suffixes: string[] = [];
  for (const ww of WAKE_WORDS) {
    // Get the last word (e.g. "mentra" from "hey mentra")
    const lastWord = ww.split(' ').pop() || '';
    // Generate suffixes of length 1 to lastWord.length - 1
    // (full word is handled by detectWakeWord itself)
    for (let len = 1; len < lastWord.length; len++) {
      suffixes.push(lastWord.slice(-len));
    }
  }
  // Match any of these suffixes at the start of text, but ONLY if followed by
  // punctuation (comma, period, etc.) — this prevents stripping real words like
  // "a dog" or "are you there". The pattern requires at least one punctuation
  // char after the fragment before any remaining text.
  // e.g. matches "a," or "ra, " or "ntra." but NOT "a dog" or "are"
  const escaped = suffixes.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^(?:${escaped.join('|')})[,.!?;:]+\\s*`, 'i');
})();

/**
 * Remove wake word from text (if present)
 * @param text - The transcription text
 * @returns Text with wake word removed
 */
export function removeWakeWord(text: string): string {
  const result = detectWakeWord(text);
  return result.query;
}

/**
 * Strip leading wake word fragment residue from text.
 * Call this on text that arrives AFTER a wake word was already detected in a
 * previous utterance — Deepgram may have split "mentra" across utterance
 * boundaries, leaving "a," or "tra," at the start of the next utterance.
 */
export function stripWakeWordResidue(text: string): string {
  return text.replace(WAKE_WORD_TRAILING_FRAGMENTS, '').trim();
}

/**
 * Check if a query requires vision/camera analysis
 * @param query - The user's query text
 * @returns true if the query needs camera input
 */
export function isVisionQuery(query: string): boolean {
  const q = query.toLowerCase();
  return VISION_KEYWORDS.some(kw => q.includes(kw));
}
