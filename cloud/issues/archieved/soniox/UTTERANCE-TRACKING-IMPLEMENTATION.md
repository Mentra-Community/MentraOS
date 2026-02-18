# Utterance-Based Tracking Implementation for Soniox Translation

## Summary

This implementation adds utterance-based tracking to the Soniox translation provider to include both the original spoken text and its translation in the data sent to apps.

## Key Changes

### 1. Added Utterance Tracking Structure

```typescript
private currentUtterance: {
  startTime?: number;
  originalTokens: SonioxToken[];
  translationTokens: SonioxToken[];
  sourceLanguage?: string;
  hasBeenSent: boolean;
} = {
  originalTokens: [],
  translationTokens: [],
  hasBeenSent: false
};
```

### 2. Token Processing Updates

- Separates incoming tokens into `originalTokens` and `translationTokens` arrays
- Tracks the source language from token metadata
- Handles language switches in bidirectional translation

### 3. New sendUtterance() Method

```typescript
private sendUtterance(isFinal: boolean, reason: string): void {
  // Builds TranslationData with both original and translated text
  const translationData: TranslationData = {
    type: StreamType.TRANSLATION,
    text: translationText,
    originalText: originalText || undefined, // NEW: Include original text
    isFinal,
    startTime: utteranceStartTime,
    endTime,
    speakerId: undefined,
    duration: endTime - utteranceStartTime,
    transcribeLanguage: actualSourceLang,
    translateLanguage: actualTargetLang,
    didTranslate: true,
    provider: 'soniox',
    confidence: undefined
  };

  this.callbacks.onData?.(translationData);
}
```

### 4. Utterance Boundary Detection

- Detects `<end>` tokens to mark utterance boundaries
- Sends complete utterances with both original and translated text
- Resets buffers after each utterance

### 5. Stream Close Handling

- Updated `close()` method to send any remaining utterance data
- Ensures no data is lost when the stream closes

## Benefits

1. **Synchronized Data**: Original text and translation are guaranteed to be from the same utterance
2. **Language Accuracy**: Proper language detection for bidirectional translation
3. **Complete Information**: Apps receive both the original spoken text and its translation
4. **Clean Boundaries**: Clear utterance boundaries prevent mixing of different speech segments

## Example Output

For a French to English translation:

```json
{
  "type": "translation",
  "originalText": "Bonjour comment allez-vous",
  "text": "Hello how are you",
  "transcribeLanguage": "fr",
  "translateLanguage": "en",
  "isFinal": true,
  "provider": "soniox"
}
```

For bidirectional translation (English response):

```json
{
  "type": "translation",
  "originalText": "I'm fine thank you",
  "text": "Je vais bien merci",
  "transcribeLanguage": "en",
  "translateLanguage": "fr",
  "isFinal": true,
  "provider": "soniox"
}
```

## Testing

The implementation maintains backward compatibility with the old approach while adding the new utterance-based tracking. Apps will now receive the `originalText` field in translation data, allowing them to display or process both the original speech and its translation.
