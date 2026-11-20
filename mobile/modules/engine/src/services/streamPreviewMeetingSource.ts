/**
 * Which native decoder a preview reads: the one feeding a phone-native ACS meeting, or the one
 * inside the managed glasses relay. A lease is granted for one origin and native delivers only
 * that origin's frames to it.
 */
export type PreviewOrigin = "acs" | "relay"

/** One thing a package may preview: who owns it, which decoder shows it, and its identity. */
export interface StreamPreviewSourceInstance {
  ownerPackage: string
  /** New for every meeting and every managed stream, so a lease is never inherited by the next. */
  instanceId: string
  origin: PreviewOrigin
}

/**
 * Read-only view of what may be previewed, kept apart from AcsMeetingService and
 * PhoneStreamCoordinator so the preview coordinator never depends on either. It cannot start,
 * stop or alter a meeting or a stream: it reports which sources exist and when one ends, which is
 * what ownership authorization and source-ended cleanup need.
 */
export interface StreamPreviewMeetingSource {
  /** The source `packageName` owns and may preview right now, or null. */
  current(packageName: string): StreamPreviewSourceInstance | null
  onReleased(listener: (instanceId: string) => void): () => void
}

type OwnedInstance = {ownerPackage: string; instanceId: string}

/** The two places decoded glasses video exists on the phone, behind what the resolver needs. */
export interface StreamPreviewSourceProviders {
  acs: {current(): OwnedInstance | null; onReleased(listener: (instanceId: string) => void): () => void}
  relay: {current(): OwnedInstance | null; onReleased(listener: (instanceId: string) => void): () => void}
}

/**
 * Resolve a package's preview source by ownership alone, never by which provider a call uses.
 *
 * A package that owns the active ACS meeting previews it. Otherwise a package that owns the
 * managed relay previews that. The meeting wins when a package owns both, which is a Teams call
 * with Direct link off: the relay carries the same stream, but the meeting's decoder is the one
 * Teams receives, with its photo hold and its mute card.
 */
export function createStreamPreviewSource(providers: StreamPreviewSourceProviders): StreamPreviewMeetingSource {
  return {
    current: (packageName) => {
      const meeting = providers.acs.current()
      if (meeting && meeting.ownerPackage === packageName) return {...meeting, origin: "acs"}
      const relay = providers.relay.current()
      if (relay && relay.ownerPackage === packageName) return {...relay, origin: "relay"}
      return null
    },
    onReleased: (listener) => {
      const offAcs = providers.acs.onReleased(listener)
      const offRelay = providers.relay.onReleased(listener)
      return () => {
        offAcs()
        offRelay()
      }
    },
  }
}
