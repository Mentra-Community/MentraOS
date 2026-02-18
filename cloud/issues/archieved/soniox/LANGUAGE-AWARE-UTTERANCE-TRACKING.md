# Language-Aware Utterance Tracking Implementation

## Problem Solved

The previous implementation had a critical flaw in bidirectional translation: it used a single buffer for all languages, causing:

- Mixed language output (e.g., "Hello, my name is Isaiah Test, test, un deux trois")
- Language detection conflicts
- Translation app receiving data for the wrong language direction

## Solution

Implemented language-aware utterance tracking that:

1. **Maintains separate utterance buffers per language**
2. **Properly matches original tokens with their translations**
3. **Handles timing delays between original and translation tokens**
4. **Cleanly separates languages in bidirectional mode**

## Key Components

### 1. Language-Specific Utterance Storage

```typescript
private utterancesByLanguage = new Map<string, {
  startTime?: number;
  originalTokens: SonioxToken[];
  translationTokens: SonioxToken[];
  targetLanguage?: string;
  lastOriginalEndTime?: number;
  waitingForTranslation: boolean;
}>();
```

### 2. Token Processing by Language

- First pass: Organize incoming tokens by source language
- Second pass: Update appropriate language utterance buffer
- Handles `<end>` tokens to mark utterance boundaries

### 3. Translation Timeout Handling

- Sets a 3-second timeout when original tokens arrive
- Ensures translations are sent even if translation tokens are delayed
- Prevents indefinite waiting for translations

### 4. Clean Language Separation

When sending translation data:

- Only sends data for a specific language direction
- Properly labels source and target languages
- Includes both original and translated text

## Example Flow

**User speaks in French then English:**

1. French tokens arrive:
   - Original: "Bonjour comment allez-vous"
   - Translation: "Hello how are you"
   - Output: `{transcribeLanguage: "fr-FR", translateLanguage: "en-US", text: "Hello how are you", originalText: "Bonjour comment allez-vous"}`

2. English tokens arrive:
   - Original: "I'm fine thank you"
   - Translation: "Je vais bien merci"
   - Output: `{transcribeLanguage: "en-US", translateLanguage: "fr-FR", text: "Je vais bien merci", originalText: "I'm fine thank you"}`

## Benefits

1. **No Language Mixing**: Each utterance contains only one language direction
2. **Proper Language Detection**: Correctly identifies and labels each language
3. **Complete Information**: Apps receive synchronized original and translated text
4. **Timing Resilience**: Handles delays between original and translation tokens
5. **Clean Boundaries**: Language switches create new utterances

## Translation App Compatibility

The implementation now sends language codes in the expected BCP-47 format (e.g., "en-US", "fr-FR") to ensure compatibility with the translation app's language filtering logic.
