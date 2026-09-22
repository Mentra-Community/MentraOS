public enum AudioSourceKind: String, CaseIterable, Sendable {
  case glasses
  case phone
}

/// Mirrors (AudioStreamType, AudioStreamState). Attached-but-STOPPED reads as none.
public enum ActiveStreamKind: String, CaseIterable, Sendable {
  case none
  case virtual
  case local
}

public enum PhysicalMuteAction: String, Sendable {
  case mute
  case unmute
  case leaveAlone
}

public enum AudioSafety: String, Sendable {
  case safe
  case degraded
  case unsafe
}

public struct AudioPolicyDecision: Equatable, Sendable {
  public var glassesPcmEnabled: Bool
  public var phonePcmEnabled: Bool
  public var physicalMute: PhysicalMuteAction
}

public struct JoinAudioPlan: Equatable, Sendable {
  public var armVirtual: Bool
  public var transportMuted: Bool
}

public enum AcsAudioPolicy {
  public static func decide(
    desired: AudioSourceKind,
    active: ActiveStreamKind,
    userMuted: Bool
  ) -> AudioPolicyDecision {
    let glassesPcmEnabled = active == .virtual && desired == .glasses && !userMuted
    let phonePcmEnabled = active == .virtual && desired == .phone && !userMuted
    let physicalMute: PhysicalMuteAction
    switch active {
    case .virtual, .none:
      physicalMute = .leaveAlone
    case .local:
      physicalMute = (desired == .phone && !userMuted) ? .unmute : .mute
    }
    return AudioPolicyDecision(
      glassesPcmEnabled: glassesPcmEnabled,
      phonePcmEnabled: phonePcmEnabled,
      physicalMute: physicalMute
    )
  }

  public static func planJoin(
    desired: AudioSourceKind,
    userMuted: Bool,
    glassesRequiresUnmutedTransport: Bool
  ) -> JoinAudioPlan {
    // Phone and glasses both feed RawOutgoingAudioStream. Mute is PCM/capturer
    // gating, never a LocalOutgoingAudioStream.
    let armVirtual = true
    let transportMuted: Bool
    if desired == .glasses && glassesRequiresUnmutedTransport {
      transportMuted = false
    } else if desired == .phone {
      transportMuted = false
    } else {
      transportMuted = userMuted
    }
    return JoinAudioPlan(armVirtual: armVirtual, transportMuted: transportMuted)
  }

  public static func expectedStream(_: AudioSourceKind) -> ActiveStreamKind {
    .virtual
  }

  public static func parseSource(_ raw: String?) -> AudioSourceKind? {
    switch raw {
    case "glasses": return .glasses
    case "phone": return .phone
    default: return nil
    }
  }
}

public enum CallGuard {
  public static func require<T>(_ value: T?) -> Result<T, Error> {
    if let value {
      return .success(value)
    }
    return .failure(CallMissingError())
  }
}

public struct CallMissingError: Error, Equatable {
  public init() {}
  public var localizedDescription: String { "no call" }
}
