import { MentraSession } from "../MentraSession";

type LegacyEventName =
  | "transcription"
  | "head_position"
  | "button_press"
  | "touch_event"
  | "phone_notification"
  | "phone_notification_dismissed"
  | "vps_coordinates"
  | "photo_taken";

/**
 * V2 Event Manager Shim
 *
 * Maps every `session.events.*` method from the v2 API to the
 * corresponding v3 manager method. This is the compatibility layer
 * for code that does `session.events.onTranscription(handler)` etc.
 *
 * Note on `ontranslationForLanguage` (lowercase 'on'):
 * The v2 EventManager had this as a lowercase method name — it was a bug
 * in the original codebase that shipped and became part of the public API.
 * We preserve the lowercase version for backward compat AND add a
 * correctly-cased `onTranslationForLanguage` alias so both work.
 *
 * Removed in v3.1.
 *
 * @internal
 */
export class _V2EventManagerShim {
  private readonly session: MentraSession;

  constructor(session: MentraSession) {
    this.session = session;
  }

  onTranscription(handler: (data: any) => void): () => void {
    return this.session.transcription.on(handler);
  }

  onTranscriptionForLanguage(language: string, handler: (data: any) => void): () => void {
    return this.session.transcription.forLanguage(language, handler);
  }

  /**
   * Original v2 method name (lowercase 'on' — was a bug, shipped as public API).
   * Preserved for backward compat with code that calls `events.ontranslationForLanguage()`.
   */
  ontranslationForLanguage(source: string, target: string, handler: (data: any) => void): () => void {
    return this.session.translation.fromTo(source, target, handler);
  }

  /**
   * Correctly-cased alias. Both `onTranslationForLanguage` and `ontranslationForLanguage` work.
   */
  onTranslationForLanguage(source: string, target: string, handler: (data: any) => void): () => void {
    return this.session.translation.fromTo(source, target, handler);
  }

  onHeadPosition(handler: (data: any) => void): () => void {
    return this.session.device.onHeadPosition(handler);
  }

  onButtonPress(handler: (data: any) => void): () => void {
    return this.session.device.onButtonPress(handler);
  }

  onTouchEvent(gestureOrHandler: string | ((data: any) => void), handler?: (data: any) => void): () => void {
    if (typeof gestureOrHandler === "string") {
      return this.session.device.onTouchEvent(gestureOrHandler, handler!);
    }

    return this.session.device.onTouchEvent(gestureOrHandler);
  }

  onPhoneNotifications(handler: (data: any) => void): () => void {
    return this.session.phone.notifications.on(handler);
  }

  onPhoneNotificationDismissed(handler: (data: any) => void): () => void {
    return this.session.phone.notifications.onDismissed(handler);
  }

  onVpsCoordinates(handler: (data: any) => void): () => void {
    return this.session.device.onVpsCoordinates(handler);
  }



  onAudioChunk(handler: (data: any) => void): () => void {
    return this.session.mic.onChunk((chunk) => {
      handler({
        type: "audio_chunk",
        arrayBuffer: chunk.data,
        sampleRate: chunk.sampleRate,
        timestamp: new Date(chunk.timestamp),
      });
    });
  }

  onLocation(handler: (data: any) => void): () => void {
    return this.session.location.onUpdate(handler);
  }

  onCalendarEvent(handler: (data: any) => void): () => void {
    return this.session.phone.calendar.on(handler);
  }

  onConnected(handler: (data: any) => void): () => void {
    return this.session.onConnected(handler);
  }

  onDisconnected(handler: (data: any) => void): () => void {
    return this.session.onDisconnected(handler);
  }

  onError(handler: (data: any) => void): () => void {
    return this.session.onError(handler);
  }

  onSettingsUpdate(handler: (data: any) => void): () => void {
    return this.session.onSettings(handler);
  }

  onCapabilitiesUpdate(handler: (data: any) => void): () => void {
    return this.session.device.onCapabilitiesChange((capabilities) => {
      handler({
        capabilities,
        modelName: capabilities?.modelName ?? null,
      });
    });
  }

  on(event: LegacyEventName, handler: (data: any) => void): () => void {
    switch (event) {
      case "transcription":
        return this.onTranscription(handler);
      case "head_position":
        return this.onHeadPosition(handler);
      case "button_press":
        return this.onButtonPress(handler);
      case "touch_event":
        return this.onTouchEvent(handler);
      case "phone_notification":
        return this.onPhoneNotifications(handler);
      case "phone_notification_dismissed":
        return this.onPhoneNotificationDismissed(handler);
      case "vps_coordinates":
        return this.onVpsCoordinates(handler);

      default:
        return () => {};
    }
  }
}
