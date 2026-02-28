/**
 * @fileoverview Utility class for working with Soniox translation capabilities
 * Based on SonioxTranslationMappings.json
 */

import translationMappings from "./SonioxTranslationMappings.json";

interface TranslationTarget {
  exclude_source_languages: string[];
  source_languages: string[];
  target_language: string;
}

interface TwoWayPair {
  langA: string;
  langB: string;
}

/**
 * Utility class for Soniox translation optimization
 */
export class SonioxTranslationUtils {
  private static readonly mappings = translationMappings.models.find(
    (m) => m.id === "stt-rt-preview",
  )! as {
    id: string;
    languages: Array<{ code: string; name: string }>;
    translation_targets: Array<{
      exclude_source_languages: string[];
      source_languages: string[];
      target_language: string;
    }>;
    two_way_translation_pairs: string[];
    one_way_translation: string | null;
    two_way_translation: string | null;
  };

  /**
   * Normalize BCP 47 language codes (e.g., "fr-FR") to Soniox base codes (e.g., "fr")
   * Soniox uses ISO 639-1 base language codes without region specifiers
   */
  static normalizeLanguageCode(languageCode: string): string {
    if (!languageCode) return languageCode;

    // Extract base language code (remove region/country code)
    const baseCode = languageCode.split("-")[0].toLowerCase();

    // Special cases for Soniox mappings
    const normalizedCode = this.mapToSonioxLanguageCode(baseCode);

    return normalizedCode;
  }

  /**
   * Map base language codes to Soniox-specific language codes
   * Handle any special cases where Soniox uses different codes
   */
  private static mapToSonioxLanguageCode(baseCode: string): string {
    // Current Soniox mappings use standard ISO 639-1 codes
    // Add any special mappings here if needed in the future
    const specialMappings: Record<string, string> = {
      // Example: 'zh-cn': 'zh', 'zh-tw': 'zh' - but we already handle this above
      // Add any Soniox-specific mappings here if discovered

      // Norwegian Bokmål uses 'nb' instead of 'no'
      nb: "no",
      "nb-NO": "no",
    };

    return specialMappings[baseCode] || baseCode;
  }

  /**
   * Get all supported languages for transcription
   */
  static getSupportedLanguages(): string[] {
    return this.mappings.languages.map((lang) => lang.code);
  }

  /**
   * Get all translation targets that support multiple source languages
   */
  static getMultiSourceTargets(): Map<string, string[]> {
    const multiSourceTargets = new Map<string, string[]>();

    for (const target of this.mappings.translation_targets) {
      if (
        target.source_languages.length > 1 &&
        !target.source_languages.includes("*")
      ) {
        multiSourceTargets.set(target.target_language, target.source_languages);
      }
    }

    return multiSourceTargets;
  }

  /**
   * Get all two-way translation pairs
   */
  static getTwoWayPairs(): TwoWayPair[] {
    return this.mappings.two_way_translation_pairs.map((pair) => {
      const [langA, langB] = pair.split(":");
      return { langA, langB };
    });
  }

  /**
   * Check if a language pair supports two-way translation
   */
  static supportsTwoWayTranslation(langA: string, langB: string): boolean {
    // Normalize language codes for Soniox format
    const normalizedLangA = this.normalizeLanguageCode(langA);
    const normalizedLangB = this.normalizeLanguageCode(langB);

    // v3: Check if all language pairs are supported
    if (this.mappings.two_way_translation === "all_languages") {
      // Verify both languages are in the supported list
      const supportedLanguages = this.getSupportedLanguages();
      return (
        supportedLanguages.includes(normalizedLangA) &&
        supportedLanguages.includes(normalizedLangB) &&
        normalizedLangA !== normalizedLangB
      );
    }

    // v2: Check specific pairs
    return (
      this.mappings.two_way_translation_pairs.includes(
        `${normalizedLangA}:${normalizedLangB}`,
      ) ||
      this.mappings.two_way_translation_pairs.includes(
        `${normalizedLangB}:${normalizedLangA}`,
      )
    );
  }

  /**
   * Check if a source->target translation is supported
   */
  static supportsTranslation(
    sourceLanguage: string,
    targetLanguage: string,
  ): boolean {
    // Normalize language codes for Soniox format
    const normalizedSource = this.normalizeLanguageCode(sourceLanguage);
    const normalizedTarget = this.normalizeLanguageCode(targetLanguage);

    if (normalizedSource === normalizedTarget) return false;

    // v3: Check if all language pairs are supported
    if (this.mappings.one_way_translation === "all_languages") {
      // Verify both languages are in the supported list
      const supportedLanguages = this.getSupportedLanguages();
      return (
        supportedLanguages.includes(normalizedSource) &&
        supportedLanguages.includes(normalizedTarget)
      );
    }

    // First check if this is a two-way translation pair
    if (this.supportsTwoWayTranslation(normalizedSource, normalizedTarget)) {
      return true;
    }

    // Then check one-way translation targets (v2)
    const target = this.mappings.translation_targets.find(
      (t) => t.target_language === normalizedTarget,
    );
    if (!target) return false;

    // Check if source is explicitly excluded
    if (target.exclude_source_languages.includes(normalizedSource))
      return false;

    // Check if source is in the allowed list (or wildcard)
    return (
      target.source_languages.includes(normalizedSource) ||
      target.source_languages.includes("*")
    );
  }

  /**
   * Get the universal English translation config (any language -> English)
   */
  static getUniversalEnglishConfig(): TranslationTarget | null {
    return (
      this.mappings.translation_targets.find(
        (t) => t.target_language === "en" && t.source_languages.includes("*"),
      ) || null
    );
  }

  /**
   * Find the optimal stream configuration for a set of translation subscriptions
   */
  static optimizeTranslationStreams(
    subscriptions: string[],
  ): StreamOptimization {
    const analysis = this.analyzeSubscriptions(subscriptions);
    const ownershipAnalysis = this.analyzeTranscriptionOwnership(subscriptions);
    const streams: OptimizedStream[] = [];

    // 1. Universal English stream (highest priority)
    if (analysis.needsUniversalEnglish) {
      streams.push({
        type: "universal_english",
        config: {
          language: "auto",
          translation: {
            type: "one_way",
            target_language: "en",
          },
        },
        handledSubscriptions: analysis.englishTranslations,
        ownsTranscription: ownershipAnalysis.universalEnglishOwnership,
        skipTranscriptionFor: ownershipAnalysis.universalEnglishSkip,
        originalLanguageCodes: {
          target: "en-US", // Use standard US English for subscription format
        },
      });
    }

    // 2. Two-way pairs
    for (const pair of analysis.twoWayPairs) {
      const pairKey = `${pair.langA}:${pair.langB}`;
      streams.push({
        type: "two_way",
        config: {
          language: "auto",
          translation: {
            type: "two_way",
            language_a: pair.langA,
            language_b: pair.langB,
          },
        },
        handledSubscriptions: pair.subscriptions,
        ownsTranscription: ownershipAnalysis.twoWayOwnership.get(pairKey) || [],
        skipTranscriptionFor: ownershipAnalysis.twoWaySkip.get(pairKey) || [],
        originalLanguageCodes: {
          langA: pair.originalLangA,
          langB: pair.originalLangB,
        },
      });
    }

    // 3. Multi-source targets
    for (const [targetLang, sources] of analysis.multiSourceTargets) {
      streams.push({
        type: "multi_source",
        config: {
          language: "auto",
          translation: {
            type: "one_way",
            target_language: targetLang,
            source_languages: sources,
          },
        },
        handledSubscriptions:
          analysis.multiSourceSubscriptions.get(targetLang) || [],
        ownsTranscription:
          ownershipAnalysis.multiSourceOwnership.get(targetLang) || [],
        skipTranscriptionFor:
          ownershipAnalysis.multiSourceSkip.get(targetLang) || [],
        originalLanguageCodes: {
          target:
            analysis.multiSourceOriginalTargets.get(targetLang) || targetLang,
        },
      });
    }

    // 4. Individual streams for remaining subscriptions
    for (const sub of analysis.remainingSubscriptions) {
      const [type, langPair] = sub.split(":");
      if (type === "translation") {
        const [source, target] = langPair.split(/->|-to-/);
        const normalizedSource = this.normalizeLanguageCode(source);
        const normalizedTarget = this.normalizeLanguageCode(target);
        streams.push({
          type: "individual",
          config: {
            language: normalizedSource,
            translation: {
              type: "one_way",
              target_language: normalizedTarget,
            },
          },
          handledSubscriptions: [sub],
          ownsTranscription:
            ownershipAnalysis.individualOwnership.get(sub) || [],
          skipTranscriptionFor: ownershipAnalysis.individualSkip.get(sub) || [],
          originalLanguageCodes: {
            source: source,
            target: target,
          },
        });
      } else if (type === "transcription") {
        const normalizedLangPair = this.normalizeLanguageCode(langPair);
        streams.push({
          type: "transcription_only",
          config: {
            language: normalizedLangPair,
          },
          handledSubscriptions: [sub],
          ownsTranscription: [normalizedLangPair], // Dedicated transcription always owns its language
          skipTranscriptionFor: [],
          originalLanguageCodes: {
            source: langPair,
          },
        });
      }
    }

    return {
      streams,
      originalSubscriptions: subscriptions,
      optimizationSummary: {
        totalStreams: streams.length,
        totalSubscriptions: subscriptions.length,
        streamTypes: streams.map((s) => s.type),
      },
    };
  }

  /**
   * Analyze transcription ownership based on hierarchy rules
   */
  private static analyzeTranscriptionOwnership(
    subscriptions: string[],
  ): OwnershipAnalysis {
    const transcriptionSubs = subscriptions.filter((s) =>
      s.startsWith("transcription:"),
    );
    const translationSubs = subscriptions.filter((s) =>
      s.startsWith("translation:"),
    );

    // Extract all languages that need transcription
    const dedicatedTranscriptionLanguages = new Set<string>();
    transcriptionSubs.forEach((sub) => {
      const [, langCodeWithParams] = sub.split(":");
      // Strip query parameters for language code extraction
      const langCode = langCodeWithParams?.split("?")[0];
      dedicatedTranscriptionLanguages.add(langCode);
    });

    // Parse translation pairs to identify source languages
    const translationPairs = translationSubs.map((sub) => {
      const [, langPairWithParams] = sub.split(":");
      // Strip query parameters for language pair parsing
      const langPair = langPairWithParams?.split("?")[0];
      const [source, target] = langPair?.split(/->|-to-/) ?? [];
      return {
        source: this.normalizeLanguageCode(source),
        target: this.normalizeLanguageCode(target),
        originalSource: source,
        originalTarget: target,
        subscription: sub,
      };
    });

    // Build ownership mappings based on hierarchy
    // 1. Dedicated transcription streams (highest priority)
    // 2. Two-way translation streams
    // 3. Universal English stream
    // 4. One-way translation streams (lowest priority)

    const result: OwnershipAnalysis = {
      universalEnglishOwnership: [],
      universalEnglishSkip: [],
      twoWayOwnership: new Map(),
      twoWaySkip: new Map(),
      multiSourceOwnership: new Map(),
      multiSourceSkip: new Map(),
      individualOwnership: new Map(),
      individualSkip: new Map(),
    };

    // Step 1: Dedicated transcription languages are owned by their streams
    // All other streams must skip these languages
    const ownedByDedicated = Array.from(dedicatedTranscriptionLanguages);

    // Step 2: For two-way pairs, assign ownership if not already owned
    const twoWayPairs = this.findTwoWayPairs(translationPairs);
    for (const { langA, langB } of twoWayPairs) {
      const pairKey = `${langA}:${langB}`;
      const ownership: string[] = [];
      const skip: string[] = [];

      // Check if either language is owned by dedicated transcription
      if (!dedicatedTranscriptionLanguages.has(langA)) {
        ownership.push(langA);
      } else {
        skip.push(langA);
      }

      if (!dedicatedTranscriptionLanguages.has(langB)) {
        ownership.push(langB);
      } else {
        skip.push(langB);
      }

      result.twoWayOwnership.set(pairKey, ownership);
      result.twoWaySkip.set(pairKey, skip);
    }

    // Step 3: Universal English stream owns English if not already owned
    const hasUniversalEnglish = translationPairs.some((p) => p.target === "en");
    if (hasUniversalEnglish) {
      const englishOwnedByDedicated = dedicatedTranscriptionLanguages.has("en");
      const englishOwnedByTwoWay = Array.from(
        result.twoWayOwnership.values(),
      ).some((ownership) => ownership.includes("en"));

      if (!englishOwnedByDedicated && !englishOwnedByTwoWay) {
        result.universalEnglishOwnership = ["en"];
      } else {
        result.universalEnglishSkip = ["en"];
      }
    }

    // Step 3.5: Multi-source targets (between two-way and individual priority)
    const multiSourceTargets = this.getMultiSourceTargets();
    for (const [targetLang] of multiSourceTargets) {
      const targetPairs = translationPairs.filter(
        (p) => p.target === targetLang,
      );
      const availableSources = targetPairs.map((p) => p.source);

      if (availableSources.length > 1) {
        const ownership: string[] = [];
        const skip: string[] = [];

        for (const source of availableSources) {
          if (
            dedicatedTranscriptionLanguages.has(source) ||
            Array.from(result.twoWayOwnership.values()).some((owners) =>
              owners.includes(source),
            )
          ) {
            skip.push(source);
          } else {
            ownership.push(source);
          }
        }

        result.multiSourceOwnership.set(targetLang, ownership);
        result.multiSourceSkip.set(targetLang, skip);
      }
    }

    // Step 4: Individual streams get lowest priority (skip everything owned by higher priority)
    const allOwnedLanguages = new Set([
      ...ownedByDedicated,
      ...Array.from(result.twoWayOwnership.values()).flat(),
      ...result.universalEnglishOwnership,
      ...Array.from(result.multiSourceOwnership.values()).flat(),
    ]);

    for (const pair of translationPairs) {
      const { source, subscription } = pair;

      if (allOwnedLanguages.has(source)) {
        result.individualSkip.set(subscription, [source]);
        result.individualOwnership.set(subscription, []);
      } else {
        result.individualOwnership.set(subscription, [source]);
        result.individualSkip.set(subscription, []);
      }
    }

    return result;
  }

  /**
   * Helper method to find two-way pairs from translation pairs
   */
  private static findTwoWayPairs(
    translationPairs: Array<{
      source: string;
      target: string;
      originalSource: string;
      originalTarget: string;
      subscription: string;
    }>,
  ) {
    const pairs: Array<{
      langA: string;
      langB: string;
      originalLangA: string;
      originalLangB: string;
      subscriptions: string[];
    }> = [];
    const processed = new Set<string>();

    for (const pair of translationPairs) {
      const pairKey = `${pair.source}:${pair.target}`;
      if (processed.has(pairKey)) continue;

      const reversePair = translationPairs.find(
        (p) => p.source === pair.target && p.target === pair.source,
      );

      if (
        reversePair &&
        this.supportsTwoWayTranslation(pair.source, pair.target)
      ) {
        pairs.push({
          langA: pair.source,
          langB: pair.target,
          originalLangA: pair.originalSource,
          originalLangB: pair.originalTarget,
          subscriptions: [pair.subscription, reversePair.subscription],
        });
        processed.add(`${pair.source}:${pair.target}`);
        processed.add(`${pair.target}:${pair.source}`);
      }
    }

    return pairs;
  }

  /**
   * Analyze subscriptions to identify optimization opportunities
   */
  private static analyzeSubscriptions(
    subscriptions: string[],
  ): SubscriptionAnalysis {
    // const transcriptionSubs = subscriptions.filter((s) =>
    //   s.startsWith("transcription:"),
    // );
    const translationSubs = subscriptions.filter((s) =>
      s.startsWith("translation:"),
    );

    // Parse translation subscriptions
    const translationPairs = translationSubs.map((sub) => {
      const [, langPairWithParams] = sub.split(":");
      // Strip query parameters for language pair parsing
      const langPair = langPairWithParams?.split("?")[0];
      const [source, target] = langPair?.split(/->|-to-/) ?? [];
      return {
        source: this.normalizeLanguageCode(source),
        target: this.normalizeLanguageCode(target),
        originalSource: source,
        originalTarget: target,
        subscription: sub,
      };
    });

    // Find English translations
    const englishTranslations = translationPairs.filter(
      (p) => p.target === "en",
    );
    const needsUniversalEnglish = englishTranslations.length > 0;

    // Find two-way pairs
    const twoWayPairs: Array<{
      langA: string;
      langB: string;
      originalLangA: string;
      originalLangB: string;
      subscriptions: string[];
    }> = [];
    const processedPairs = new Set<string>();

    for (const pair of translationPairs) {
      if (processedPairs.has(`${pair.source}:${pair.target}`)) continue;

      const reversePair = translationPairs.find(
        (p) => p.source === pair.target && p.target === pair.source,
      );

      if (
        reversePair &&
        this.supportsTwoWayTranslation(pair.source, pair.target)
      ) {
        twoWayPairs.push({
          langA: pair.source,
          langB: pair.target,
          originalLangA: pair.originalSource,
          originalLangB: pair.originalTarget,
          subscriptions: [pair.subscription, reversePair.subscription],
        });
        processedPairs.add(`${pair.source}:${pair.target}`);
        processedPairs.add(`${pair.target}:${pair.source}`);
      }
    }

    // Find multi-source opportunities
    const multiSourceTargets = new Map<string, string[]>();
    const multiSourceSubscriptions = new Map<string, string[]>();
    const multiSourceOriginalTargets = new Map<string, string>(); // Track original target codes

    for (const [targetLang, supportedSources] of this.getMultiSourceTargets()) {
      const targetPairs = translationPairs.filter(
        (p) => p.target === targetLang,
      );
      const availableSources = targetPairs.map((p) => p.source);

      if (availableSources.length > 1) {
        const validSources = availableSources.filter((source) =>
          supportedSources.includes(source),
        );
        if (validSources.length > 1) {
          multiSourceTargets.set(targetLang, validSources);
          multiSourceSubscriptions.set(
            targetLang,
            targetPairs.map((p) => p.subscription),
          );
          // Use the original target from the first pair (they should all normalize to the same target)
          multiSourceOriginalTargets.set(
            targetLang,
            targetPairs[0]?.originalTarget || targetLang,
          );
        }
      }
    }

    // Calculate remaining subscriptions
    const handledSubs = new Set<string>();
    if (needsUniversalEnglish) {
      englishTranslations.forEach((p) => handledSubs.add(p.subscription));
    }
    twoWayPairs.forEach((pair) =>
      pair.subscriptions.forEach((sub) => handledSubs.add(sub)),
    );
    multiSourceSubscriptions.forEach((subs) =>
      subs.forEach((sub) => handledSubs.add(sub)),
    );

    const remainingSubscriptions = subscriptions.filter(
      (sub) => !handledSubs.has(sub),
    );

    return {
      needsUniversalEnglish,
      englishTranslations: englishTranslations.map((p) => p.subscription),
      twoWayPairs,
      multiSourceTargets,
      multiSourceSubscriptions,
      multiSourceOriginalTargets,
      remainingSubscriptions,
    };
  }
}

// Types
interface SubscriptionAnalysis {
  needsUniversalEnglish: boolean;
  englishTranslations: string[];
  twoWayPairs: Array<{
    langA: string;
    langB: string;
    originalLangA: string;
    originalLangB: string;
    subscriptions: string[];
  }>;
  multiSourceTargets: Map<string, string[]>;
  multiSourceSubscriptions: Map<string, string[]>;
  multiSourceOriginalTargets: Map<string, string>;
  remainingSubscriptions: string[];
}

interface OwnershipAnalysis {
  universalEnglishOwnership: string[];
  universalEnglishSkip: string[];
  twoWayOwnership: Map<string, string[]>;
  twoWaySkip: Map<string, string[]>;
  multiSourceOwnership: Map<string, string[]>;
  multiSourceSkip: Map<string, string[]>;
  individualOwnership: Map<string, string[]>;
  individualSkip: Map<string, string[]>;
}

interface OptimizedStream {
  type:
    | "universal_english"
    | "two_way"
    | "multi_source"
    | "individual"
    | "transcription_only";
  config: SonioxStreamConfig;
  handledSubscriptions: string[];
  ownsTranscription: string[]; // Languages this stream owns for transcription
  skipTranscriptionFor: string[]; // Languages to skip sending transcription for
  originalLanguageCodes?: {
    // Original language codes for subscription creation
    source?: string;
    target?: string;
    langA?: string;
    langB?: string;
  };
}

interface StreamOptimization {
  streams: OptimizedStream[];
  originalSubscriptions: string[];
  optimizationSummary: {
    totalStreams: number;
    totalSubscriptions: number;
    streamTypes: string[];
  };
}

interface SonioxStreamConfig {
  language: string;
  translation?: {
    type: "one_way" | "two_way";
    target_language?: string;
    source_languages?: string[];
    language_a?: string;
    language_b?: string;
  };
}
