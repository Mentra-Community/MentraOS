# Translation Subscriptions

MentraOS supports real-time translation powered by Soniox v3, enabling live captions and conversations across 60+ languages.

## Subscription Formats

### 1. Universal Translation (One-Way)

Translate from **any language** to a single target language.

```typescript
import { createUniversalTranslationStream } from "@mentra/sdk";

// Subscribe to translations from ANY language → Spanish
const subscription = createUniversalTranslationStream("es-ES");
// Returns: "translation:all-to-es-ES"

session.subscribe(subscription);
```

**Use case:** Live captions app where you want all speech translated to user's preferred language.

**How it works:**

- English speaker talks → Spanish translation ✓
- French speaker talks → Spanish translation ✓
- German speaker talks → Spanish translation ✓
- **Any of 60+ languages → Spanish translation ✓**

**Soniox config:**

```json
{
  "translation": {
    "type": "one_way",
    "target_language": "es"
  }
}
```

### 2. Specific Language Pair (Two-Way)

Translate between **two specific languages** for better accuracy.

```typescript
import { createTranslationStream } from "@mentra/sdk";

// Subscribe to English ⟷ Spanish translations
const subscription = createTranslationStream("en-US", "es-ES");
// Returns: "translation:en-US-to-es-ES"

session.subscribe(subscription);
```

**Use case:** Video call or conversation between English and Spanish speakers.

**How it works:**

- English speech → Spanish translation ✓
- Spanish speech → English translation ✓
- French speech → Only transcribed (NOT translated) ✗

**Soniox config:**

```json
{
  "translation": {
    "type": "two_way",
    "language_a": "en",
    "language_b": "es"
  }
}
```

**Why use two-way?**

- Better accuracy with explicit language hints
- Soniox knows exactly which two languages to expect
- Optimized for bidirectional conversations

## Examples

### Live Captions App

```typescript
import { AppSession, createUniversalTranslationStream } from "@mentra/sdk";

const session = new AppSession({
  packageName: "com.example.livecaptions",
  apiKey: process.env.API_KEY!,
});

// User's preferred caption language
const userLanguage = "es-ES"; // Spanish

// Subscribe to universal translation
const subscription = createUniversalTranslationStream(userLanguage);
session.subscribe(subscription);

// Handle translation data
session.on("translation", (data) => {
  if (data.isFinal) {
    console.log(`[${data.sourceLanguage}] ${data.originalText}`);
    console.log(`[${data.targetLanguage}] ${data.translatedText}`);

    // Display caption
    displayCaption(data.translatedText);
  }
});
```

### Two-Way Conversation App

```typescript
import { AppSession, createTranslationStream } from "@mentra/sdk";

const session = new AppSession({
  packageName: "com.example.translator",
  apiKey: process.env.API_KEY!,
});

// Bidirectional English ⟷ Japanese
const subscription = createTranslationStream("en-US", "ja-JP");
session.subscribe(subscription);

// Handle translations
session.on("translation", (data) => {
  if (data.isFinal) {
    console.log(`Original [${data.sourceLanguage}]: ${data.originalText}`);
    console.log(`Translated [${data.targetLanguage}]: ${data.translatedText}`);
  }
});
```

### Multiple Target Languages

If you need translations to multiple languages, subscribe to multiple streams:

```typescript
// User wants captions in both Spanish AND French
const spanishSub = createUniversalTranslationStream("es-ES");
const frenchSub = createUniversalTranslationStream("fr-FR");

session.subscribe(spanishSub);
session.subscribe(frenchSub);

// You'll receive translation events for both languages
session.on("translation", (data) => {
  if (data.targetLanguage === "es") {
    displaySpanishCaption(data.translatedText);
  } else if (data.targetLanguage === "fr") {
    displayFrenchCaption(data.translatedText);
  }
});
```

## Translation Data Format

```typescript
interface TranslationData {
  text: string; // Translated text
  originalText: string; // Original spoken text
  sourceLanguage: string; // Language that was spoken (e.g., "en")
  targetLanguage: string; // Language of translation (e.g., "es")
  isFinal: boolean; // true = final, false = interim
  confidence?: number; // Confidence score (0-1)
  provider: string; // "soniox"
}
```

## Token Stream Behavior

Soniox streams transcription and translation tokens together:

```
[Original] Hello everyone,
[Translation] Bonjour à tous,

[Original] thank you
[Translation] merci

[Original] for joining us
[Translation] de nous avoir rejoints
```

**Key points:**

- Original transcription tokens arrive first
- Translation tokens follow immediately
- Tokens stream in real-time (mid-sentence)
- Not 1-to-1 mapped (translation may chunk differently)

## Supported Languages

All 60+ languages supported by Soniox, including:

- English (en), Spanish (es), French (fr), German (de)
- Chinese (zh), Japanese (ja), Korean (ko)
- Arabic (ar), Hindi (hi), Russian (ru)
- Portuguese (pt), Italian (it), Dutch (nl)
- And 50+ more...

See [Soniox documentation](https://soniox.com/docs/) for complete list.

## Choosing Between Universal and Two-Way

| Use Case                                 | Best Choice               | Why                        |
| ---------------------------------------- | ------------------------- | -------------------------- |
| Live captions for any language           | Universal (`all-to-LANG`) | Maximum flexibility        |
| Specific conversation (e.g., EN⟷ES call) | Two-way (`LANG-to-LANG`)  | Better accuracy with hints |
| Multi-language meeting → One language    | Universal                 | Handles all speakers       |
| Language learning app                    | Two-way                   | Focus on specific pair     |
| Accessibility captions                   | Universal                 | Support all users          |

## Performance Considerations

### Universal Translation (One-Way)

- ✅ Handles any source language
- ✅ Simple configuration
- ⚠️ Slightly higher latency (auto language detection)

### Two-Way Translation

- ✅ Lower latency (known languages)
- ✅ Better accuracy (explicit hints)
- ❌ Only works for the specified pair

## Migration from v2 to v3

If you're upgrading from Soniox v2:

**v2 (Limited Pairs):**

```typescript
// Only worked if en⟷es was in the supported pairs list
createTranslationStream("en-US", "es-ES");
```

**v3 (All Languages):**

```typescript
// Now works for ANY language pair!
createTranslationStream("en-US", "es-ES");
createTranslationStream("fr-FR", "ja-JP");
createTranslationStream("de-DE", "ko-KR");
// ALL combinations supported!

// Plus new universal mode:
createUniversalTranslationStream("es-ES");
```

## Advanced Options

### Disable Language Identification

```typescript
// Skip language identification for faster processing
const subscription = createUniversalTranslationStream("es-ES", {
  disableLanguageIdentification: true,
});
```

⚠️ Only use if you're certain about the source language.

## Troubleshooting

### No translations received

1. Check subscription is correct:

   ```typescript
   console.log(subscription); // Should be "translation:all-to-es-ES" or "translation:en-US-to-es-ES"
   ```

2. Verify microphone permission:

   ```typescript
   // Translations require MICROPHONE permission
   permissions: [PermissionType.MICROPHONE];
   ```

3. Check event listener:
   ```typescript
   session.on("translation", (data) => {
     console.log("Translation received:", data);
   });
   ```

### Only getting transcription, not translation

- Ensure you're subscribed to `translation:*`, not `transcription:*`
- Check `data.translatedText` (not just `data.text`)
- Verify target language is in supported list

### Mixed language audio but no translation

- Use universal translation (`all-to-LANG`)
- Ensure `enable_language_identification: true` in config
- Two-way mode only translates the specified pair

## API Reference

### `createUniversalTranslationStream(targetLanguage, options?)`

Creates a subscription for universal translation (any language → target).

**Parameters:**

- `targetLanguage` (string): BCP-47 language code (e.g., "es-ES")
- `options` (optional):
  - `disableLanguageIdentification` (boolean): Skip language detection

**Returns:** `ExtendedStreamType` - Subscription string like "translation:all-to-es-ES"

### `createTranslationStream(sourceLanguage, targetLanguage, options?)`

Creates a subscription for two-way translation between specific languages.

**Parameters:**

- `sourceLanguage` (string): Source BCP-47 code (e.g., "en-US")
- `targetLanguage` (string): Target BCP-47 code (e.g., "es-ES")
- `options` (optional):
  - `disableLanguageIdentification` (boolean): Skip language detection

**Returns:** `ExtendedStreamType` - Subscription string like "translation:en-US-to-es-ES"

## See Also

- [Transcription Subscriptions](./TRANSCRIPTION_SUBSCRIPTIONS.md)
- [Soniox Translation Docs](https://soniox.com/docs/stt/rt/real-time-translation)
- [Supported Languages](https://soniox.com/docs/stt/models)
