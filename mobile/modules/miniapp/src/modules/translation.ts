/**
 * @fileoverview TranslationModule — top-level translation API.
 *
 * Mirrors cloud SDK v3's TranslationManager surface:
 *
 *   session.translation.on(handler)                          // any pair
 *   session.translation.to(target, handler)                  // any-source → target
 *   session.translation.to([targets], handler)               // any-source → many
 *   session.translation.fromTo(source, target, handler)      // specific pair
 *   session.translation.fromTo(source, [targets], handler)   // source → many
 *   session.translation.stop()                                // tear down all
 *
 * Internally each subscribe registers against a `translation:<source>:<target>`
 * stream pattern; LocalMiniappRuntime's wildcard matcher routes incoming
 * `translation:<src>:<dst>` events to any matching `*` patterns.
 *
 * MICROPHONE permission required.
 */

import {MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {TranslationData, UnsubscribeFn} from "./events"
import {requireTranscriptionLanguage} from "./languages"
import type {TranscriptionLanguage} from "./languages"

export type TranslationHandler = (data: TranslationData) => void

/**
 * Translation source: a registry language, or "auto" to let the cloud detect
 * the spoken language.
 */
export type TranslationSource = TranscriptionLanguage | "auto"

export class TranslationModule {
  private readonly unsubs = new Set<UnsubscribeFn>()

  constructor(private readonly session: MiniappSession) {}

  /**
   * Subscribe to every translation event from the cloud, regardless of
   * source or target language.
   *
   * Uses the wildcard stream `translation:*:*` — cheap to register on the
   * client, expensive on the cloud side (cloud fans every active pair out
   * to this subscriber). Prefer `to` or `fromTo` when you know the
   * language(s) you care about.
   */
  on(handler: TranslationHandler): UnsubscribeFn {
    return this.track(
      this.session._subscribe(
        `${MiniappStreamType.TRANSLATION}:*:*`,
        handler as (data: unknown) => void,
      ),
    )
  }

  /**
   * Subscribe to any translation that lands at the given target language(s),
   * regardless of source. Useful for "I'm a Spanish speaker, translate
   * whatever I hear to Spanish."
   */
  to(target: TranscriptionLanguage | TranscriptionLanguage[], handler: TranslationHandler): UnsubscribeFn {
    const targets = (Array.isArray(target) ? target : [target]).map((t) =>
      requireTranscriptionLanguage(t, "translation.to(target)"),
    )
    if (targets.length === 0) return () => {}
    const unsubs: UnsubscribeFn[] = []
    for (const t of targets) {
      unsubs.push(
        this.session._subscribe(
          `${MiniappStreamType.TRANSLATION}:*:${t}`,
          handler as (data: unknown) => void,
        ),
      )
    }
    const composite = () => {
      for (const u of unsubs) {
        try {
          u()
        } catch {
          /* ignore */
        }
      }
    }
    return this.track(composite)
  }

  /**
   * Subscribe to a specific source → target translation pair. Pass an
   * array for `target` to fan a single handler across multiple targets
   * from the same source.
   */
  fromTo(
    source: TranslationSource,
    target: TranscriptionLanguage | TranscriptionLanguage[],
    handler: TranslationHandler,
  ): UnsubscribeFn {
    const validSource =
      source === "auto" ? "auto" : requireTranscriptionLanguage(source, "translation.fromTo(source)")
    const targets = (Array.isArray(target) ? target : [target]).map((t) =>
      requireTranscriptionLanguage(t, "translation.fromTo(target)"),
    )
    if (targets.length === 0) return () => {}
    const unsubs: UnsubscribeFn[] = []
    for (const t of targets) {
      unsubs.push(
        this.session._subscribe(
          `${MiniappStreamType.TRANSLATION}:${validSource}:${t}`,
          handler as (data: unknown) => void,
        ),
      )
    }
    const composite = () => {
      for (const u of unsubs) {
        try {
          u()
        } catch {
          /* ignore */
        }
      }
    }
    return this.track(composite)
  }

  /**
   * @deprecated Renamed to `fromTo(source, target, handler)` for cloud
   * SDK v3 parity. This alias will be removed in a future release.
   */
  forLanguagePair(
    fromLang: TranslationSource,
    toLang: TranscriptionLanguage,
    handler: TranslationHandler,
  ): UnsubscribeFn {
    return this.fromTo(fromLang, toLang, handler)
  }

  /** Tear down every translation subscription this module owns. */
  stop(): void {
    for (const u of this.unsubs) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    this.unsubs.clear()
  }

  /** True iff `MICROPHONE` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("MICROPHONE")
  }

  // ------------------------------------------------------------------------

  private track(unsub: UnsubscribeFn): UnsubscribeFn {
    this.unsubs.add(unsub)
    return () => {
      this.unsubs.delete(unsub)
      unsub()
    }
  }
}
