/**
 * @fileoverview TranslationModule — top-level translation API.
 *
 * Mirrors cloud SDK v3's TranslationManager. Hoisted to top-level (vs.
 * nested under `session.mic`) for the same reason as transcription.
 *
 *   session.translation.forLanguagePair("en-US", "es-ES", handler)
 *   session.translation.stop()                                     // tear down all
 *
 * MICROPHONE permission required.
 */

import {MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {TranslationData, UnsubscribeFn} from "./events"

export class TranslationModule {
  private readonly unsubs = new Set<UnsubscribeFn>()

  constructor(private readonly session: MiniappSession) {}

  /**
   * Subscribe to a fromLang→toLang translation stream. Each call is
   * independent; multiple language pairs can run simultaneously.
   */
  forLanguagePair(
    fromLang: string,
    toLang: string,
    handler: (data: TranslationData) => void,
  ): UnsubscribeFn {
    return this.track(
      this.session._subscribe(
        `${MiniappStreamType.TRANSLATION}:${fromLang}:${toLang}`,
        handler as (data: unknown) => void,
      ),
    )
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
