(() => {
  var __create = Object.create;
  var __getProtoOf = Object.getPrototypeOf;
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __toESM = (mod, isNodeMode, target) => {
    target = mod != null ? __create(__getProtoOf(mod)) : {};
    const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: () => mod[key],
          enumerable: true
        });
    return to;
  };
  var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);

  // ../node_modules/.bun/eventemitter3@5.0.4/node_modules/eventemitter3/index.js
  var require_eventemitter3 = __commonJS((exports, module) => {
    var has = Object.prototype.hasOwnProperty;
    var prefix = "~";
    function Events() {}
    if (Object.create) {
      Events.prototype = Object.create(null);
      if (!new Events().__proto__)
        prefix = false;
    }
    function EE(fn, context, once) {
      this.fn = fn;
      this.context = context;
      this.once = once || false;
    }
    function addListener(emitter, event, fn, context, once) {
      if (typeof fn !== "function") {
        throw new TypeError("The listener must be a function");
      }
      var listener = new EE(fn, context || emitter, once), evt = prefix ? prefix + event : event;
      if (!emitter._events[evt])
        emitter._events[evt] = listener, emitter._eventsCount++;
      else if (!emitter._events[evt].fn)
        emitter._events[evt].push(listener);
      else
        emitter._events[evt] = [emitter._events[evt], listener];
      return emitter;
    }
    function clearEvent(emitter, evt) {
      if (--emitter._eventsCount === 0)
        emitter._events = new Events;
      else
        delete emitter._events[evt];
    }
    function EventEmitter() {
      this._events = new Events;
      this._eventsCount = 0;
    }
    EventEmitter.prototype.eventNames = function eventNames() {
      var names = [], events, name;
      if (this._eventsCount === 0)
        return names;
      for (name in events = this._events) {
        if (has.call(events, name))
          names.push(prefix ? name.slice(1) : name);
      }
      if (Object.getOwnPropertySymbols) {
        return names.concat(Object.getOwnPropertySymbols(events));
      }
      return names;
    };
    EventEmitter.prototype.listeners = function listeners(event) {
      var evt = prefix ? prefix + event : event, handlers = this._events[evt];
      if (!handlers)
        return [];
      if (handlers.fn)
        return [handlers.fn];
      for (var i = 0, l = handlers.length, ee = new Array(l);i < l; i++) {
        ee[i] = handlers[i].fn;
      }
      return ee;
    };
    EventEmitter.prototype.listenerCount = function listenerCount(event) {
      var evt = prefix ? prefix + event : event, listeners = this._events[evt];
      if (!listeners)
        return 0;
      if (listeners.fn)
        return 1;
      return listeners.length;
    };
    EventEmitter.prototype.emit = function emit(event, a1, a2, a3, a4, a5) {
      var evt = prefix ? prefix + event : event;
      if (!this._events[evt])
        return false;
      var listeners = this._events[evt], len = arguments.length, args, i;
      if (listeners.fn) {
        if (listeners.once)
          this.removeListener(event, listeners.fn, undefined, true);
        switch (len) {
          case 1:
            return listeners.fn.call(listeners.context), true;
          case 2:
            return listeners.fn.call(listeners.context, a1), true;
          case 3:
            return listeners.fn.call(listeners.context, a1, a2), true;
          case 4:
            return listeners.fn.call(listeners.context, a1, a2, a3), true;
          case 5:
            return listeners.fn.call(listeners.context, a1, a2, a3, a4), true;
          case 6:
            return listeners.fn.call(listeners.context, a1, a2, a3, a4, a5), true;
        }
        for (i = 1, args = new Array(len - 1);i < len; i++) {
          args[i - 1] = arguments[i];
        }
        listeners.fn.apply(listeners.context, args);
      } else {
        var length = listeners.length, j;
        for (i = 0;i < length; i++) {
          if (listeners[i].once)
            this.removeListener(event, listeners[i].fn, undefined, true);
          switch (len) {
            case 1:
              listeners[i].fn.call(listeners[i].context);
              break;
            case 2:
              listeners[i].fn.call(listeners[i].context, a1);
              break;
            case 3:
              listeners[i].fn.call(listeners[i].context, a1, a2);
              break;
            case 4:
              listeners[i].fn.call(listeners[i].context, a1, a2, a3);
              break;
            default:
              if (!args)
                for (j = 1, args = new Array(len - 1);j < len; j++) {
                  args[j - 1] = arguments[j];
                }
              listeners[i].fn.apply(listeners[i].context, args);
          }
        }
      }
      return true;
    };
    EventEmitter.prototype.on = function on(event, fn, context) {
      return addListener(this, event, fn, context, false);
    };
    EventEmitter.prototype.once = function once(event, fn, context) {
      return addListener(this, event, fn, context, true);
    };
    EventEmitter.prototype.removeListener = function removeListener(event, fn, context, once) {
      var evt = prefix ? prefix + event : event;
      if (!this._events[evt])
        return this;
      if (!fn) {
        clearEvent(this, evt);
        return this;
      }
      var listeners = this._events[evt];
      if (listeners.fn) {
        if (listeners.fn === fn && (!once || listeners.once) && (!context || listeners.context === context)) {
          clearEvent(this, evt);
        }
      } else {
        for (var i = 0, events = [], length = listeners.length;i < length; i++) {
          if (listeners[i].fn !== fn || once && !listeners[i].once || context && listeners[i].context !== context) {
            events.push(listeners[i]);
          }
        }
        if (events.length)
          this._events[evt] = events.length === 1 ? events[0] : events;
        else
          clearEvent(this, evt);
      }
      return this;
    };
    EventEmitter.prototype.removeAllListeners = function removeAllListeners(event) {
      var evt;
      if (event) {
        evt = prefix ? prefix + event : event;
        if (this._events[evt])
          clearEvent(this, evt);
      } else {
        this._events = new Events;
        this._eventsCount = 0;
      }
      return this;
    };
    EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
    EventEmitter.prototype.addListener = EventEmitter.prototype.on;
    EventEmitter.prefixed = prefix;
    EventEmitter.EventEmitter = EventEmitter;
    if (typeof module !== "undefined") {
      module.exports = EventEmitter;
    }
  });

  // ../node_modules/.bun/eventemitter3@5.0.4/node_modules/eventemitter3/index.mjs
  var import__ = __toESM(require_eventemitter3(), 1);

  // ../../mobile/modules/miniapp/dist/envelope.js
  function serializeEnvelope(envelope) {
    return JSON.stringify(envelope);
  }
  function parseEnvelope(raw) {
    if (typeof raw !== "string")
      return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null)
      return null;
    const obj = parsed;
    if (typeof obj.payload !== "object" || obj.payload === null)
      return null;
    if (obj.requestId !== undefined && typeof obj.requestId !== "string")
      return null;
    return {
      payload: obj.payload,
      requestId: obj.requestId
    };
  }
  function makeRequestId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  // ../../mobile/modules/miniapp/dist/globals.js
  function getMentraOSGlobals() {
    if (typeof window === "undefined")
      return {};
    return window.MentraOS ?? {};
  }

  // ../../mobile/modules/miniapp/dist/protocol.js
  var MiniappRequestType;
  (function(MiniappRequestType2) {
    MiniappRequestType2["CONNECT"] = "miniapp_connect";
    MiniappRequestType2["SUBSCRIBE"] = "miniapp_subscribe";
    MiniappRequestType2["DISPLAY"] = "miniapp_display";
    MiniappRequestType2["PLAY_AUDIO"] = "miniapp_play_audio";
    MiniappRequestType2["STOP_AUDIO"] = "miniapp_stop_audio";
    MiniappRequestType2["SPEAK"] = "miniapp_speak";
    MiniappRequestType2["RGB_LED"] = "miniapp_rgb_led";
    MiniappRequestType2["LOCATION_POLL"] = "miniapp_location_poll";
    MiniappRequestType2["NAVIGATION_START"] = "miniapp_navigation_start";
    MiniappRequestType2["NAVIGATION_STOP"] = "miniapp_navigation_stop";
    MiniappRequestType2["NAVIGATION_DEVIATE"] = "miniapp_navigation_deviate";
    MiniappRequestType2["NAVIGATION_SET_WRONG_SIDEWALK"] = "miniapp_navigation_set_wrong_sidewalk";
    MiniappRequestType2["NAVIGATION_SET_SKIP_CROSSINGS"] = "miniapp_navigation_set_skip_crossings";
    MiniappRequestType2["NAVIGATION_GET_STATE"] = "miniapp_navigation_get_state";
    MiniappRequestType2["NAVIGATION_COMPUTE_ROUTE"] = "miniapp_navigation_compute_route";
    MiniappRequestType2["NAVIGATION_REQUEST_PERMISSION"] = "miniapp_navigation_request_permission";
    MiniappRequestType2["STORAGE_GET"] = "miniapp_storage_get";
    MiniappRequestType2["STORAGE_SET"] = "miniapp_storage_set";
    MiniappRequestType2["STORAGE_DELETE"] = "miniapp_storage_delete";
    MiniappRequestType2["STORAGE_LIST"] = "miniapp_storage_list";
    MiniappRequestType2["STORAGE_CLEAR"] = "miniapp_storage_clear";
    MiniappRequestType2["STORAGE_HAS"] = "miniapp_storage_has";
    MiniappRequestType2["STORAGE_GET_ALL"] = "miniapp_storage_get_all";
    MiniappRequestType2["STORAGE_SET_MULTIPLE"] = "miniapp_storage_set_multiple";
    MiniappRequestType2["STORAGE_FLUSH"] = "miniapp_storage_flush";
    MiniappRequestType2["CAMERA_FOV"] = "miniapp_camera_fov";
    MiniappRequestType2["SHARE"] = "miniapp_share";
    MiniappRequestType2["OPEN_URL"] = "miniapp_open_url";
    MiniappRequestType2["COPY_CLIPBOARD"] = "miniapp_copy_clipboard";
    MiniappRequestType2["DOWNLOAD"] = "miniapp_download";
    MiniappRequestType2["PING"] = "miniapp_ping";
    MiniappRequestType2["TRANSCRIPTION_CONFIG"] = "miniapp_transcription_config";
    MiniappRequestType2["DASHBOARD_CONTENT_UPDATE"] = "miniapp_dashboard_content_update";
    MiniappRequestType2["PHOTO"] = "miniapp_photo";
    MiniappRequestType2["STREAM_START"] = "miniapp_stream_start";
    MiniappRequestType2["STREAM_STOP"] = "miniapp_stream_stop";
    MiniappRequestType2["MANAGED_STREAM_START"] = "miniapp_managed_stream_start";
    MiniappRequestType2["MANAGED_STREAM_STOP"] = "miniapp_managed_stream_stop";
  })(MiniappRequestType || (MiniappRequestType = {}));
  var MiniappResponseType;
  (function(MiniappResponseType2) {
    MiniappResponseType2["CONNECT_ACK"] = "miniapp_connect_ack";
    MiniappResponseType2["EVENT"] = "miniapp_event";
    MiniappResponseType2["REQUEST_RESULT"] = "miniapp_request_result";
    MiniappResponseType2["CAPABILITIES_UPDATE"] = "miniapp_capabilities_update";
    MiniappResponseType2["VISIBILITY_CHANGE"] = "miniapp_visibility_change";
    MiniappResponseType2["COLOR_SCHEME_CHANGE"] = "miniapp_color_scheme_change";
    MiniappResponseType2["SPEAKER_STATE"] = "miniapp_speaker_state";
    MiniappResponseType2["PERMISSIONS_UPDATE"] = "miniapp_permissions_update";
    MiniappResponseType2["PONG"] = "miniapp_pong";
    MiniappResponseType2["WILL_DISCONNECT"] = "miniapp_will_disconnect";
    MiniappResponseType2["ERROR"] = "miniapp_error";
  })(MiniappResponseType || (MiniappResponseType = {}));
  var MiniappStreamType;
  (function(MiniappStreamType2) {
    MiniappStreamType2["BUTTON_PRESS"] = "button_press";
    MiniappStreamType2["TOUCH_EVENT"] = "touch_event";
    MiniappStreamType2["HEAD_POSITION"] = "head_position";
    MiniappStreamType2["GLASSES_BATTERY"] = "glasses_battery";
    MiniappStreamType2["PHONE_BATTERY"] = "phone_battery";
    MiniappStreamType2["GLASSES_CONNECTION"] = "glasses_connection";
    MiniappStreamType2["TRANSCRIPTION"] = "transcription";
    MiniappStreamType2["TRANSLATION"] = "translation";
    MiniappStreamType2["AUDIO_CHUNK"] = "audio_chunk";
    MiniappStreamType2["VAD"] = "vad";
    MiniappStreamType2["LOCATION_UPDATE"] = "location_update";
    MiniappStreamType2["HEADING_UPDATE"] = "heading_update";
    MiniappStreamType2["NAVIGATION_UPDATE"] = "navigation_update";
    MiniappStreamType2["NAVIGATION_ROUTE"] = "navigation_route";
    MiniappStreamType2["PHONE_NOTIFICATION"] = "phone_notification";
    MiniappStreamType2["PHONE_NOTIFICATION_DISMISSED"] = "phone_notification_dismissed";
    MiniappStreamType2["CALENDAR_EVENT"] = "calendar_event";
    MiniappStreamType2["PHOTO_TAKEN"] = "photo_taken";
    MiniappStreamType2["STREAM_STATUS"] = "stream_status";
  })(MiniappStreamType || (MiniappStreamType = {}));
  var MiniappErrorCode;
  (function(MiniappErrorCode2) {
    MiniappErrorCode2["PERMISSION_NOT_DECLARED"] = "PERMISSION_NOT_DECLARED";
    MiniappErrorCode2["NOT_IMPLEMENTED"] = "NOT_IMPLEMENTED";
    MiniappErrorCode2["REQUEST_ABORTED"] = "REQUEST_ABORTED";
    MiniappErrorCode2["INTERNAL"] = "INTERNAL";
    MiniappErrorCode2["TTS_TEXT_TOO_LONG"] = "TTS_TEXT_TOO_LONG";
    MiniappErrorCode2["TTS_INVALID_VOICE"] = "TTS_INVALID_VOICE";
    MiniappErrorCode2["TTS_UPSTREAM_ERROR"] = "TTS_UPSTREAM_ERROR";
    MiniappErrorCode2["NOT_CONNECTED"] = "NOT_CONNECTED";
  })(MiniappErrorCode || (MiniappErrorCode = {}));

  // ../../mobile/modules/miniapp/dist/transport/dispatch.js
  class DispatchTransport {
    constructor() {
      this.messageHandler = null;
      this.disconnectHandler = null;
      this.open_ = false;
    }
    static isAvailable() {
      return typeof globalThis.__dispatch === "function";
    }
    async open() {
      if (!DispatchTransport.isAvailable()) {
        throw new Error("DispatchTransport: __dispatch is not installed on globalThis");
      }
      const g = globalThis;
      g.__mentraDeliverBridgeRaw = (raw) => {
        if (this.messageHandler)
          this.messageHandler(raw);
      };
      this.open_ = true;
    }
    send(raw) {
      if (!this.open_) {
        throw new Error("DispatchTransport: send() before open()");
      }
      const g = globalThis;
      if (typeof g.__dispatch !== "function") {
        this.open_ = false;
        this.disconnectHandler?.("DispatchTransport: __dispatch disappeared");
        return;
      }
      try {
        g.__dispatch("__bridge", "send", JSON.stringify([raw]));
      } catch (e) {
        this.disconnectHandler?.(`DispatchTransport: __dispatch threw: ${String(e)}`);
      }
    }
    onMessage(handler) {
      this.messageHandler = handler;
    }
    onDisconnect(handler) {
      this.disconnectHandler = handler;
    }
    close() {
      this.open_ = false;
      const g = globalThis;
      if (g.__mentraDeliverBridgeRaw) {
        delete g.__mentraDeliverBridgeRaw;
      }
    }
    isOpen() {
      return this.open_;
    }
  }

  // ../../mobile/modules/miniapp/dist/transport/local-socket.js
  var DEFAULT_URL = "ws://127.0.0.1:8765";

  class LocalSocketTransport {
    constructor(options = {}) {
      this.ws = null;
      this.messageHandler = null;
      this.disconnectHandler = null;
      this.url = options.url ?? DEFAULT_URL;
    }
    async open() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN)
        return;
      if (typeof WebSocket === "undefined") {
        throw new Error("LocalSocketTransport: browser WebSocket global not available");
      }
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(this.url);
        let settled = false;
        const settle = (fn) => {
          if (settled)
            return;
          settled = true;
          fn();
        };
        ws.onopen = () => {
          this.ws = ws;
          settle(() => resolve());
        };
        ws.onerror = (ev) => {
          settle(() => reject(new Error(`LocalSocketTransport: failed to connect to ${this.url}: ${String(ev)}`)));
        };
        ws.onmessage = (ev) => {
          const data = ev.data;
          if (typeof data === "string")
            this.messageHandler?.(data);
        };
        ws.onclose = (ev) => {
          if (this.ws === ws)
            this.ws = null;
          this.disconnectHandler?.(`closed: ${ev.code} ${ev.reason}`);
        };
      });
    }
    send(raw) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error("LocalSocketTransport: not connected");
      }
      this.ws.send(raw);
    }
    onMessage(handler) {
      this.messageHandler = handler;
    }
    onDisconnect(handler) {
      this.disconnectHandler = handler;
    }
    close() {
      if (!this.ws)
        return;
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    isOpen() {
      return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }
  }

  // ../../mobile/modules/miniapp/dist/transport/mock.js
  var LOG_PREFIX = "[mock-transport]";
  function isMockExplicitlyRequested() {
    if (typeof window === "undefined")
      return false;
    try {
      if (typeof window.location !== "undefined" && window.location.search) {
        const params = new URLSearchParams(window.location.search);
        if (params.get("mentra") === "mock")
          return true;
      }
    } catch {}
    try {
      if (typeof localStorage !== "undefined" && localStorage.getItem("MENTRA_MOCK") === "1") {
        return true;
      }
    } catch {}
    return false;
  }

  class MockTransport {
    constructor(options = {}) {
      this.messageHandler = null;
      this.disconnectHandler = null;
      this.open_ = false;
      this.userId = options.userId ?? "mock-user";
      this.packageName = options.packageName ?? null;
      this.silent = options.silent === true;
    }
    async open() {
      if (this.open_)
        return;
      this.open_ = true;
      this.log("transport opened (no real host; synthetic responses only)");
    }
    send(raw) {
      if (!this.open_) {
        throw new Error("MockTransport: send() before open()");
      }
      const envelope = parseEnvelope(raw);
      if (!envelope) {
        this.log("dropped unparseable envelope:", raw.slice(0, 200));
        return;
      }
      const payload = envelope.payload;
      const type = payload?.type;
      this.log(`recv ${type ?? "<unknown>"}${envelope.requestId ? ` (rid=${envelope.requestId})` : ""}`);
      switch (type) {
        case MiniappRequestType.CONNECT:
          this.deliverConnectAck(payload);
          return;
        case MiniappRequestType.PING:
          return;
        case MiniappRequestType.SUBSCRIBE:
          return;
        default:
          if (envelope.requestId) {
            this.deliverSyntheticResult(envelope.requestId, type ?? "<unknown>");
          }
          return;
      }
    }
    onMessage(handler) {
      this.messageHandler = handler;
    }
    onDisconnect(handler) {
      this.disconnectHandler = handler;
    }
    close() {
      if (!this.open_)
        return;
      this.open_ = false;
      this.disconnectHandler?.("MockTransport.close()");
    }
    isOpen() {
      return this.open_;
    }
    deliverConnectAck(connectPayload) {
      const incomingPackage = connectPayload.packageName ?? this.packageName ?? "com.mock.app";
      const ackPayload = {
        type: MiniappResponseType.CONNECT_ACK,
        userId: this.userId,
        packageName: incomingPackage,
        capabilities: null,
        visibility: "foreground",
        colorScheme: "light"
      };
      const envelope = { payload: ackPayload };
      this.log(`-> CONNECT_ACK userId=${this.userId} pkg=${incomingPackage}`);
      queueMicrotask(() => this.messageHandler?.(serializeEnvelope(envelope)));
    }
    deliverSyntheticResult(requestId, requestType) {
      const data = syntheticDataFor(requestType);
      const responsePayload = {
        type: MiniappResponseType.REQUEST_RESULT,
        ok: true,
        data
      };
      const envelope = { payload: responsePayload, requestId };
      this.log(`-> REQUEST_RESULT (rid=${requestId}) synthetic ${requestType}`);
      queueMicrotask(() => this.messageHandler?.(serializeEnvelope(envelope)));
    }
    log(...args) {
      if (this.silent)
        return;
      console.log(LOG_PREFIX, ...args);
    }
  }
  function syntheticDataFor(requestType) {
    switch (requestType) {
      case MiniappRequestType.PHOTO:
        return {
          photoUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
          requestId: "mock-photo"
        };
      case MiniappRequestType.LOCATION_POLL:
        return { lat: 37.7956, lng: -122.3933, accuracy: 0, timestamp: Date.now() };
      case MiniappRequestType.STORAGE_GET:
        return { value: null };
      case MiniappRequestType.STORAGE_LIST:
        return { keys: [] };
      case MiniappRequestType.SPEAK:
        return { audioUrl: null, durationMs: 0 };
      case MiniappRequestType.SHARE:
      case MiniappRequestType.OPEN_URL:
      case MiniappRequestType.COPY_CLIPBOARD:
      case MiniappRequestType.DOWNLOAD:
        return { ok: true };
      default:
        return null;
    }
  }

  // ../../mobile/modules/miniapp/dist/transport/postmessage.js
  class PostMessageTransport {
    constructor() {
      this.messageHandler = null;
      this.disconnectHandler = null;
      this.open_ = false;
      this.windowListener = null;
    }
    async open() {
      if (this.open_)
        return;
      if (typeof window === "undefined" || !window.ReactNativeWebView) {
        throw new Error("PostMessageTransport: not running inside a React Native WebView");
      }
      this.windowListener = (ev) => {
        const data = ev.data;
        if (typeof data !== "string")
          return;
        this.messageHandler?.(data);
      };
      window.addEventListener("message", this.windowListener);
      if (typeof document !== "undefined") {
        document.addEventListener("message", this.windowListener);
      }
      window.receiveNativeMessage = (raw) => {
        this.messageHandler?.(raw);
      };
      this.open_ = true;
    }
    send(raw) {
      if (typeof window === "undefined" || !window.ReactNativeWebView) {
        throw new Error("PostMessageTransport: not running inside a React Native WebView");
      }
      window.ReactNativeWebView.postMessage(raw);
    }
    onMessage(handler) {
      this.messageHandler = handler;
    }
    onDisconnect(handler) {
      this.disconnectHandler = handler;
    }
    close() {
      if (!this.open_)
        return;
      this.open_ = false;
      if (this.windowListener) {
        window.removeEventListener("message", this.windowListener);
        if (typeof document !== "undefined") {
          document.removeEventListener("message", this.windowListener);
        }
        this.windowListener = null;
      }
      if (typeof window !== "undefined" && window.receiveNativeMessage) {
        window.receiveNativeMessage = undefined;
      }
      this.disconnectHandler?.("closed");
    }
    isOpen() {
      return this.open_;
    }
  }

  // ../../mobile/modules/miniapp/dist/transport/auto.js
  var LOCAL_SOCKET_OPEN_TIMEOUT_MS = 500;
  function createTransport(options = {}) {
    if (options.transport)
      return options.transport;
    if (DispatchTransport.isAvailable()) {
      return new DispatchTransport;
    }
    if (typeof window !== "undefined" && window.ReactNativeWebView) {
      return new PostMessageTransport;
    }
    if (isMockExplicitlyRequested()) {
      return new MockTransport;
    }
    if (typeof WebSocket !== "undefined") {
      const localSocketOptions = {};
      if (options.localSocketUrl)
        localSocketOptions.url = options.localSocketUrl;
      return new LocalSocketWithMockFallback(localSocketOptions);
    }
    return new MockTransport;
  }

  class LocalSocketWithMockFallback {
    constructor(options) {
      this.options = options;
      this.active = null;
      this.messageHandler = null;
      this.disconnectHandler = null;
    }
    async open() {
      const local = new LocalSocketTransport(this.options);
      let timedOut = false;
      const timeout = new Promise((_, reject) => {
        setTimeout(() => {
          timedOut = true;
          reject(new Error("LocalSocketTransport open timed out"));
        }, LOCAL_SOCKET_OPEN_TIMEOUT_MS);
      });
      try {
        await Promise.race([local.open(), timeout]);
        this.active = local;
      } catch {
        try {
          local.close();
        } catch {}
        const mock = new MockTransport;
        await mock.open();
        this.active = mock;
        console.log(timedOut ? "[mentra-miniapp] No phone WebSocket reachable; using MockTransport so the page can render." : "[mentra-miniapp] LocalSocketTransport failed; using MockTransport.");
      }
      if (this.messageHandler)
        this.active.onMessage(this.messageHandler);
      if (this.disconnectHandler)
        this.active.onDisconnect(this.disconnectHandler);
    }
    send(raw) {
      if (!this.active)
        throw new Error("LocalSocketWithMockFallback: send() before open()");
      this.active.send(raw);
    }
    onMessage(handler) {
      this.messageHandler = handler;
      this.active?.onMessage(handler);
    }
    onDisconnect(handler) {
      this.disconnectHandler = handler;
      this.active?.onDisconnect(handler);
    }
    close() {
      this.active?.close();
    }
    isOpen() {
      return this.active?.isOpen() === true;
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/camera.js
  class CameraModule {
    constructor(session) {
      this.session = session;
    }
    get hasPermission() {
      return this.session._hasManifestPermission("CAMERA");
    }
    setFov(options) {
      this.session.sendOneShot({
        type: MiniappRequestType.CAMERA_FOV,
        horizontal: options.horizontal,
        vertical: options.vertical
      });
    }
    async takePhoto(options = {}) {
      return this.session.sendRequest({
        type: MiniappRequestType.PHOTO,
        size: options.size ?? "medium",
        compress: options.compress ?? "none",
        sound: options.sound ?? true,
        saveToGallery: options.saveToGallery ?? false
      });
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/dashboard.js
  class DashboardAPI {
    constructor(session) {
      this.session = session;
      this.warned = false;
    }
    setContent(mode, content) {
      if (!this.warned) {
        console.warn("[@mentra/miniapp] dashboard.setContent() is deferred in v1.");
        this.warned = true;
      }
      this.session.sendOneShot({
        type: MiniappRequestType.DASHBOARD_CONTENT_UPDATE,
        mode,
        content
      });
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/display.js
  class DisplayManager {
    constructor(session) {
      this.session = session;
    }
    send(layout, options = {}) {
      this.session.sendOneShot({
        type: MiniappRequestType.DISPLAY,
        view: options.view ?? "main",
        layout,
        durationMs: options.durationMs
      });
    }
    showTextWall(text, options = {}) {
      this.send({ layoutType: "text_wall", text }, options);
    }
    showDoubleTextWall(topText, bottomText, options = {}) {
      this.send({ layoutType: "double_text_wall", topText, bottomText }, options);
    }
    showReferenceCard(title, text, options = {}) {
      this.send({ layoutType: "reference_card", title, text }, options);
    }
    showDashboardCard(leftText, rightText) {
      this.send({ layoutType: "dashboard_card", leftText, rightText }, { view: "dashboard" });
    }
    showBitmapView(data, options = {}) {
      this.send({ layoutType: "bitmap_view", data }, options);
    }
    clearView(view = "main") {
      this.send({ layoutType: "clear_view" }, { view });
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/events.js
  class EventManager {
    constructor(session) {
      this.session = session;
      this.emitter = new import__.default;
      this.refCounts = new Map;
    }
    subscribe(stream, handler) {
      this.emitter.on(stream, handler);
      const isInternal = stream.startsWith("_");
      if (!isInternal) {
        const before = this.refCounts.get(stream) ?? 0;
        this.refCounts.set(stream, before + 1);
        if (before === 0) {
          this.sendSubscriptionUpdate();
        }
      }
      return () => {
        this.emitter.off(stream, handler);
        if (isInternal)
          return;
        const current = this.refCounts.get(stream) ?? 0;
        if (current <= 1) {
          this.refCounts.delete(stream);
          this.sendSubscriptionUpdate();
        } else {
          this.refCounts.set(stream, current - 1);
        }
      };
    }
    unsubscribeAll() {
      this.emitter.removeAllListeners();
      this.refCounts.clear();
      this.sendSubscriptionUpdate();
    }
    _forwardEvent(stream, data) {
      this.emitter.emit(stream, data);
      if (stream.startsWith("transcription:") && stream !== "transcription:auto") {
        this.emitter.emit("transcription:auto", data);
      } else if (stream.startsWith("translation:") && stream !== "translation:auto") {
        this.emitter.emit("translation:auto", data);
      }
    }
    sendSubscriptionUpdate() {
      const subscriptions = Array.from(this.refCounts.keys()).map((stream) => stream === MiniappStreamType.LOCATION_UPDATE ? { stream: "location_stream", rate: "realtime" } : stream);
      this.session.sendOneShot({
        type: MiniappRequestType.SUBSCRIBE,
        subscriptions
      });
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/glasses.js
  class GlassesModule {
    constructor(session) {
      this.session = session;
    }
    onBattery(handler) {
      return this.session._subscribe(MiniappStreamType.GLASSES_BATTERY, handler);
    }
    onConnection(handler) {
      return this.session._subscribe(MiniappStreamType.GLASSES_CONNECTION, handler);
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/heading.js
  class HeadingModule {
    constructor(session) {
      this.session = session;
    }
    get hasPermission() {
      return this.session._hasManifestPermission("LOCATION");
    }
    onUpdate(handler) {
      return this.session._subscribe(MiniappStreamType.HEADING_UPDATE, handler);
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/imu.js
  class ImuModule {
    constructor(session) {
      this.session = session;
    }
    onHeadPosition(handler) {
      return this.session._subscribe(MiniappStreamType.HEAD_POSITION, handler);
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/input.js
  class InputModule {
    constructor(session) {
      this.session = session;
    }
    onButtonPress(handler) {
      return this.session._subscribe(MiniappStreamType.BUTTON_PRESS, handler);
    }
    onTouch(gestureOrHandler, maybeHandler) {
      if (typeof gestureOrHandler === "function") {
        return this.session._subscribe(MiniappStreamType.TOUCH_EVENT, gestureOrHandler);
      }
      const handler = maybeHandler;
      const gestures = Array.isArray(gestureOrHandler) ? gestureOrHandler : [gestureOrHandler];
      if (gestures.length === 0)
        return () => {};
      const unsubs = [];
      for (const g of gestures) {
        unsubs.push(this.session._subscribe(`${MiniappStreamType.TOUCH_EVENT}:${g}`, handler));
      }
      return () => {
        for (const u of unsubs) {
          try {
            u();
          } catch {}
        }
      };
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/led.js
  class LedModule {
    constructor(session) {
      this.session = session;
    }
    async turnOn(options = {}) {
      this.session.sendOneShot({
        type: MiniappRequestType.RGB_LED,
        action: "on",
        color: options.color ?? "red",
        ontime: options.ontime ?? 1000,
        offtime: options.offtime ?? 0,
        count: options.count ?? 1
      });
    }
    async turnOff() {
      this.session.sendOneShot({
        type: MiniappRequestType.RGB_LED,
        action: "off"
      });
    }
    async blink(color, ontime, offtime, count) {
      return this.turnOn({ color, ontime, offtime, count });
    }
    async solid(color, duration) {
      return this.turnOn({ color, ontime: duration, offtime: 0, count: 1 });
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/location.js
  class LocationModule {
    constructor(session) {
      this.session = session;
    }
    get hasPermission() {
      return this.session._hasManifestPermission("LOCATION");
    }
    onUpdate(handler) {
      return this.session._subscribe(MiniappStreamType.LOCATION_UPDATE, handler);
    }
    getOnce() {
      return this.session.sendRequest({
        type: MiniappRequestType.LOCATION_POLL
      });
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/mic.js
  class MicModule {
    constructor(session) {
      this.session = session;
      this.unsubs = new Set;
    }
    onVoiceActivity(handler) {
      return this.track(this.session._subscribe(MiniappStreamType.VAD, handler));
    }
    onAudioChunk(handler) {
      return this.track(this.session._subscribe(MiniappStreamType.AUDIO_CHUNK, handler));
    }
    stop() {
      for (const u of this.unsubs) {
        try {
          u();
        } catch {}
      }
      this.unsubs.clear();
    }
    get hasPermission() {
      return this.session._hasManifestPermission("MICROPHONE");
    }
    track(unsub) {
      this.unsubs.add(unsub);
      return () => {
        this.unsubs.delete(unsub);
        unsub();
      };
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/pivots/geometry.js
  var TURN_THRESHOLD_DEG = 25;
  var SAME_DIR_MERGE_M = 25;
  var RDP_EPSILON_M = 5;
  var MIN_BEND_PER_POINT_DEG = 10;
  var STRAIGHT_SEGMENT_BREAK_M = 1;
  var INTERSECTION_CLUSTER_M = 30;
  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function bearingDeg(a, b) {
    const toRad = (d) => d * Math.PI / 180;
    const toDeg = (r) => r * 180 / Math.PI;
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const dLng = toRad(b.lng - a.lng);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }
  function signedAngleDiff(target, actual) {
    return (target - actual + 540) % 360 - 180;
  }
  function rdpSimplify(points, epsilonMeters) {
    if (points.length < 3)
      return points.map((_, i) => i);
    const keep = new Array(points.length).fill(false);
    keep[0] = true;
    keep[points.length - 1] = true;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [lo, hi] = stack.pop();
      let maxDist = 0;
      let maxIdx = -1;
      for (let i = lo + 1;i < hi; i++) {
        const d = perpDistMeters(points[i], points[lo], points[hi]);
        if (d > maxDist) {
          maxDist = d;
          maxIdx = i;
        }
      }
      if (maxIdx !== -1 && maxDist > epsilonMeters) {
        keep[maxIdx] = true;
        stack.push([lo, maxIdx], [maxIdx, hi]);
      }
    }
    const out = [];
    for (let i = 0;i < keep.length; i++)
      if (keep[i])
        out.push(i);
    return out;
  }
  function perpDistMeters(p, a, b) {
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos(a.lat * Math.PI / 180);
    const bx = (b.lng - a.lng) * mPerDegLng;
    const by = (b.lat - a.lat) * mPerDegLat;
    const px = (p.lng - a.lng) * mPerDegLng;
    const py = (p.lat - a.lat) * mPerDegLat;
    const dx = bx;
    const dy = by;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0)
      return Math.sqrt(px * px + py * py);
    return Math.abs(dx * -py - -px * dy) / len;
  }
  function extractPivots(rawPoints) {
    if (rawPoints.length < 3)
      return [];
    const keptIdx = rdpSimplify(rawPoints, RDP_EPSILON_M);
    const simplified = keptIdx.map((i) => rawPoints[i]);
    if (simplified.length < 3)
      return [];
    const deltas = [];
    for (let i = 1;i < simplified.length - 1; i++) {
      const inBearing = bearingDeg(simplified[i - 1], simplified[i]);
      const outBearing = bearingDeg(simplified[i], simplified[i + 1]);
      deltas.push(signedAngleDiff(outBearing, inBearing));
    }
    const candidates = [];
    let runStart = -1;
    let runSum = 0;
    let runSign = 0;
    const flushRun = (endExclusive) => {
      if (runStart === -1)
        return;
      if (Math.abs(runSum) >= TURN_THRESHOLD_DEG) {
        let bestIdx = runStart;
        let bestAbs = 0;
        for (let k = runStart;k < endExclusive; k++) {
          const a = Math.abs(deltas[k]);
          if (a > bestAbs) {
            bestAbs = a;
            bestIdx = k;
          }
        }
        const simplifiedIdx = bestIdx + 1;
        candidates.push({
          lat: simplified[simplifiedIdx].lat,
          lng: simplified[simplifiedIdx].lng,
          direction: runSum > 0 ? "right" : "left",
          simplifiedRouteIndex: simplifiedIdx,
          rawRouteIndex: keptIdx[simplifiedIdx],
          headingDelta: runSum
        });
      }
      runStart = -1;
      runSum = 0;
      runSign = 0;
    };
    let metersSinceLastBend = 0;
    for (let k = 0;k < deltas.length; k++) {
      const d = deltas[k];
      const sign = d > 0 ? 1 : d < 0 ? -1 : 0;
      const segLen = haversineMeters(simplified[k + 1], simplified[k + 2]);
      if (sign === 0 || Math.abs(d) < MIN_BEND_PER_POINT_DEG) {
        if (runStart !== -1) {
          if (sign === runSign || sign === 0)
            runSum += d;
          metersSinceLastBend += segLen;
          if (metersSinceLastBend >= STRAIGHT_SEGMENT_BREAK_M) {
            flushRun(k + 1);
          }
        }
        continue;
      }
      if (runStart === -1) {
        runStart = k;
        runSum = d;
        runSign = sign;
        metersSinceLastBend = segLen;
      } else if (sign === runSign) {
        if (metersSinceLastBend >= STRAIGHT_SEGMENT_BREAK_M) {
          flushRun(k);
          runStart = k;
          runSum = d;
          runSign = sign;
        } else {
          runSum += d;
        }
        metersSinceLastBend = segLen;
      } else {
        flushRun(k);
        runStart = k;
        runSum = d;
        runSign = sign;
        metersSinceLastBend = segLen;
      }
    }
    flushRun(deltas.length);
    const merged = [];
    for (const p of candidates) {
      const last = merged[merged.length - 1];
      if (last && last.direction === p.direction && haversineMeters({ lat: last.lat, lng: last.lng }, { lat: p.lat, lng: p.lng }) < SAME_DIR_MERGE_M) {
        if (Math.abs(p.headingDelta) > Math.abs(last.headingDelta)) {
          merged[merged.length - 1] = p;
        }
        continue;
      }
      merged.push(p);
    }
    const clustered = [];
    for (const p of merged) {
      const last = clustered[clustered.length - 1];
      if (last && haversineMeters({ lat: last.lat, lng: last.lng }, { lat: p.lat, lng: p.lng }) < INTERSECTION_CLUSTER_M) {
        const netDelta = last.headingDelta + p.headingDelta;
        const anchor = Math.abs(p.headingDelta) > Math.abs(last.headingDelta) ? p : last;
        clustered[clustered.length - 1] = {
          ...anchor,
          direction: netDelta > 0 ? "right" : "left",
          headingDelta: netDelta
        };
        continue;
      }
      clustered.push(p);
    }
    return clustered.filter((p) => Math.abs(p.headingDelta) >= TURN_THRESHOLD_DEG);
  }
  function extractCrossings(points, opts = {}) {
    const maxLeg = opts.maxLegMeters ?? 25;
    const minBend = opts.minBendDeg ?? 60;
    const minSwitch = opts.minSidewalkSwitchMeters ?? 4;
    const sampleMeters = 10;
    const out = [];
    if (points.length < 4)
      return out;
    for (let i = 1;i < points.length - 2; i++) {
      const prev = points[i - 1];
      const here = points[i];
      const next = points[i + 1];
      const afterNext = points[i + 2];
      const legOut = haversineMeters(here, next);
      if (legOut >= maxLeg)
        continue;
      const bearIn = bearingDeg(prev, here);
      const bearOut = bearingDeg(here, next);
      const bend = Math.abs(signedAngleDiff(bearIn, bearOut));
      if (bend <= minBend)
        continue;
      const bearAfter = bearingDeg(next, afterNext);
      const bendBack = Math.abs(signedAngleDiff(bearOut, bearAfter));
      const inOutDelta = Math.abs(signedAngleDiff(bearIn, bearAfter));
      if (!(bendBack > minBend && inOutDelta < minBend))
        continue;
      const sample = walkAlongPolyline(points, i + 1, sampleMeters);
      if (!sample)
        continue;
      const displacement = perpDistanceMeters(sample, prev, here);
      if (displacement < minSwitch)
        continue;
      out.push({ startIndex: i, endIndex: i + 1, lat: here.lat, lng: here.lng });
    }
    return out;
  }
  function walkAlongPolyline(points, startIdx, meters) {
    if (startIdx >= points.length - 1)
      return null;
    let remaining = meters;
    let idx = startIdx;
    while (idx < points.length - 1) {
      const a = points[idx];
      const b = points[idx + 1];
      const segLen = haversineMeters(a, b);
      if (remaining <= segLen) {
        const t = segLen > 0 ? remaining / segLen : 0;
        return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
      }
      remaining -= segLen;
      idx++;
    }
    return null;
  }
  function perpDistanceMeters(p, a, b) {
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos(a.lat * Math.PI / 180);
    const ax = a.lng * mPerDegLng;
    const ay = a.lat * mPerDegLat;
    const bx = b.lng * mPerDegLng;
    const by = b.lat * mPerDegLat;
    const px = p.lng * mPerDegLng;
    const py = p.lat * mPerDegLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0)
      return Math.hypot(px - ax, py - ay);
    return Math.abs(dx * (py - ay) - dy * (px - ax)) / len;
  }
  function cumulativeDistances(points) {
    const out = new Array(points.length);
    out[0] = 0;
    for (let i = 1;i < points.length; i++) {
      out[i] = out[i - 1] + haversineMeters(points[i - 1], points[i]);
    }
    return out;
  }

  // ../../mobile/modules/miniapp/dist/modules/pivots/engine.js
  var RADIUS_DEFAULTS_M = {
    walking: 7,
    cycling: 15,
    driving: 40,
    two_wheeler: 25
  };
  var APPROACH_DEFAULTS_M = {
    walking: 100,
    cycling: 300,
    driving: 800,
    two_wheeler: 500
  };
  var NON_TURN_MANEUVERS = new Set(["STRAIGHT", "NAME_CHANGE", "DEPART", "ARRIVE"]);
  var STEP_MATCH_MAX_INDEX_DELTA = 8;
  var CROSS_MERGE_M = 15;
  var ON_ROUTE_PERP_TOLERANCE_M = 50;

  class PivotEngine {
    constructor(mode, opts) {
      this.pivots = [];
      this.states = [];
      this.cursor = 0;
      this.activePivotIndex = null;
      this.points = [];
      this.cumulative = [];
      this.subscribers = new Set;
      this.opts = resolveOptions(mode, opts);
    }
    updateOptions(mode, opts) {
      this.opts = resolveOptions(mode, opts);
      for (const p of this.pivots) {
        p.radiusMeters = this.opts.radiusMeters;
      }
    }
    reset() {
      if (this.activePivotIndex !== null) {
        const active = this.pivots[this.activePivotIndex];
        if (active)
          this.emit({ kind: "exited", pivot: active });
      }
      this.pivots = [];
      this.states = [];
      this.cursor = 0;
      this.activePivotIndex = null;
      this.points = [];
      this.cumulative = [];
    }
    setRoute(route, _userPosition) {
      const points = route.points ?? [];
      const steps = route.steps ?? [];
      if (this.activePivotIndex !== null) {
        const active = this.pivots[this.activePivotIndex];
        if (active)
          this.emit({ kind: "exited", pivot: active });
      }
      if (points.length < 3) {
        this.pivots = [];
        this.states = [];
        this.cursor = 0;
        this.activePivotIndex = null;
        this.points = [];
        this.cumulative = [];
        return;
      }
      const cumulative = cumulativeDistances(points);
      const raw = extractPivots(points);
      const stepIndex = buildStepIndex(steps);
      const pivots = [];
      for (let i = 0;i < raw.length; i++) {
        const r = raw[i];
        const matched = matchStep(r, stepIndex);
        if (matched && NON_TURN_MANEUVERS.has(matched.maneuver)) {
          continue;
        }
        pivots.push({
          index: pivots.length,
          lat: r.lat,
          lng: r.lng,
          direction: r.direction,
          fromRoad: matched?.fromRoad ?? null,
          toRoad: matched?.toRoad ?? null,
          maneuver: matched?.maneuver ?? (r.direction === "left" ? "TURN_LEFT" : "TURN_RIGHT"),
          distanceAlongRouteMeters: distanceAtIndex(cumulative, r.rawRouteIndex),
          radiusMeters: this.opts.radiusMeters
        });
      }
      const crossings = extractCrossings(points);
      for (const c of crossings) {
        const along = distanceAtIndex(cumulative, c.startIndex);
        const nearTurn = pivots.some((p) => Math.abs(p.distanceAlongRouteMeters - along) < CROSS_MERGE_M);
        if (nearTurn)
          continue;
        pivots.push({
          index: -1,
          lat: c.lat,
          lng: c.lng,
          direction: "right",
          fromRoad: null,
          toRoad: null,
          maneuver: "CROSS_STREET",
          distanceAlongRouteMeters: along,
          radiusMeters: this.opts.radiusMeters
        });
      }
      pivots.sort((a, b) => a.distanceAlongRouteMeters - b.distanceAlongRouteMeters);
      for (let i = 0;i < pivots.length; i++)
        pivots[i].index = i;
      this.pivots = pivots;
      this.states = pivots.map(() => ({ approachingFired: false, entered: false, exited: false }));
      this.cursor = 0;
      this.activePivotIndex = null;
      this.points = points;
      this.cumulative = cumulative;
    }
    onLocationUpdate(coords) {
      if (this.pivots.length === 0)
        return;
      const projection = projectOntoPolyline(this.points, this.cumulative, coords);
      const useAlongPath = projection !== null && projection.perpMeters <= ON_ROUTE_PERP_TOLERANCE_M;
      const userAlong = projection?.alongMeters ?? 0;
      for (let i = this.cursor;i < this.pivots.length; i++) {
        const pivot = this.pivots[i];
        const state = this.states[i];
        if (state.exited)
          continue;
        const aheadDelta = pivot.distanceAlongRouteMeters - userAlong;
        const distanceToPivot = useAlongPath ? Math.abs(aheadDelta) : haversineMeters(coords, { lat: pivot.lat, lng: pivot.lng });
        const approaching = !state.approachingFired && distanceToPivot <= this.opts.approachThresholdMeters && (!useAlongPath || aheadDelta >= -this.opts.radiusMeters);
        if (approaching) {
          state.approachingFired = true;
          this.emit({ kind: "approaching", pivot, distanceMeters: distanceToPivot });
        }
        if (!state.entered && distanceToPivot <= pivot.radiusMeters) {
          state.entered = true;
          this.activePivotIndex = i;
          this.emit({ kind: "entered", pivot });
        }
        const movedPastOnPath = useAlongPath && aheadDelta < -pivot.radiusMeters;
        if ((state.entered && distanceToPivot > pivot.radiusMeters || !state.entered && movedPastOnPath) && !state.exited) {
          if (!state.entered) {
            state.entered = true;
            this.activePivotIndex = i;
            this.emit({ kind: "entered", pivot });
          }
          state.exited = true;
          if (this.activePivotIndex === i)
            this.activePivotIndex = null;
          this.emit({ kind: "exited", pivot });
          if (this.cursor <= i)
            this.cursor = i + 1;
        }
        if (!state.approachingFired && distanceToPivot > this.opts.approachThresholdMeters * 2) {
          break;
        }
      }
    }
    subscribe(fn) {
      this.subscribers.add(fn);
      return () => {
        this.subscribers.delete(fn);
      };
    }
    getPivots() {
      return this.pivots.slice();
    }
    getActivePivot() {
      if (this.activePivotIndex === null)
        return null;
      return this.pivots[this.activePivotIndex] ?? null;
    }
    getUpcomingPivot() {
      for (let i = this.cursor;i < this.pivots.length; i++) {
        if (!this.states[i].exited)
          return this.pivots[i];
      }
      return null;
    }
    emit(event) {
      for (const fn of this.subscribers) {
        try {
          fn(event);
        } catch (err) {
          console.error("[PivotEngine] subscriber threw:", err);
        }
      }
    }
  }
  function resolveOptions(mode, opts) {
    return {
      radiusMeters: opts?.radiusMeters ?? RADIUS_DEFAULTS_M[mode] ?? RADIUS_DEFAULTS_M.walking,
      approachThresholdMeters: opts?.approachThresholdMeters ?? APPROACH_DEFAULTS_M[mode] ?? APPROACH_DEFAULTS_M.walking
    };
  }
  function projectOntoPolyline(points, cumulative, user) {
    if (points.length < 2 || cumulative.length !== points.length)
      return null;
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos(user.lat * Math.PI / 180);
    const ux = user.lng * mPerDegLng;
    const uy = user.lat * mPerDegLat;
    let bestPerp = Number.POSITIVE_INFINITY;
    let bestAlong = 0;
    for (let i = 0;i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const ax = a.lng * mPerDegLng;
      const ay = a.lat * mPerDegLat;
      const bx = b.lng * mPerDegLng;
      const by = b.lat * mPerDegLat;
      const dx = bx - ax;
      const dy = by - ay;
      const segLen2 = dx * dx + dy * dy;
      const t = segLen2 > 0 ? Math.max(0, Math.min(1, ((ux - ax) * dx + (uy - ay) * dy) / segLen2)) : 0;
      const px = ax + t * dx;
      const py = ay + t * dy;
      const perp = Math.hypot(ux - px, uy - py);
      if (perp < bestPerp) {
        bestPerp = perp;
        const segLen = Math.sqrt(segLen2);
        bestAlong = cumulative[i] + t * segLen;
      }
    }
    if (!Number.isFinite(bestPerp))
      return null;
    return { perpMeters: bestPerp, alongMeters: bestAlong };
  }
  function distanceAtIndex(cumulative, idx) {
    if (cumulative.length === 0)
      return 0;
    if (idx < 0)
      return 0;
    if (idx >= cumulative.length)
      return cumulative[cumulative.length - 1];
    return cumulative[idx];
  }
  function buildStepIndex(steps) {
    if (!steps.length)
      return [];
    return steps.slice().sort((a, b) => a.routeIndex - b.routeIndex);
  }
  function matchStep(raw, stepIndex) {
    if (stepIndex.length < 2)
      return null;
    let bestJ = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 1;i < stepIndex.length; i++) {
      const delta = Math.abs(stepIndex[i].routeIndex - raw.rawRouteIndex);
      if (delta <= bestDelta) {
        bestDelta = delta;
        bestJ = i;
      }
    }
    if (bestJ < 1)
      return null;
    if (bestDelta > STEP_MATCH_MAX_INDEX_DELTA)
      return null;
    const SHORT_TRANSIT_METERS = 25;
    let j = bestJ;
    while (j < stepIndex.length - 1 && stepIndex[j].distanceMeters > 0 && stepIndex[j].distanceMeters < SHORT_TRANSIT_METERS) {
      j++;
    }
    const fromStep = stepIndex[bestJ - 1];
    const toStep = stepIndex[j];
    return {
      fromRoad: fromStep.road ?? null,
      toRoad: toStep.road ?? null,
      maneuver: fromStep.maneuver
    };
  }

  // ../../mobile/modules/miniapp/dist/modules/navigation.js
  class NavigationModule {
    constructor(session) {
      this.session = session;
      this._pivots = new PivotEngine("walking", undefined);
      this._tripUnsubs = [];
    }
    get hasPermission() {
      return this.session._hasManifestPermission("LOCATION");
    }
    requestPermission() {
      if (!this.hasPermission) {
        return Promise.resolve({
          ok: false,
          accepted: false,
          error: "LOCATION permission not declared in miniapp.json (required for navigation.requestPermission)."
        });
      }
      return this.session.sendRequest({
        type: MiniappRequestType.NAVIGATION_REQUEST_PERMISSION
      });
    }
    start(opts) {
      if (!this.hasPermission) {
        return Promise.resolve({
          ok: false,
          error: "LOCATION permission not declared in miniapp.json (required for navigation.start)."
        });
      }
      const stops = normalizeStops(opts);
      const mode = opts.mode ?? "driving";
      this._attachPivotTrackingForTrip(mode, opts.pivots);
      return this.session.sendRequest({
        type: MiniappRequestType.NAVIGATION_START,
        lat: stops[0]?.lat,
        lng: stops[0]?.lng,
        stops,
        mode,
        avoid: opts.avoid,
        simulate: opts.simulate ?? false,
        speedMultiplier: opts.speedMultiplier ?? 5,
        missedTurnRerouteMeters: opts.missedTurnRerouteMeters
      });
    }
    stop() {
      this._detachPivotTracking();
      this.session.sendOneShot({ type: MiniappRequestType.NAVIGATION_STOP });
    }
    get dev() {
      return {
        deviate: (offsetMeters = 20) => {
          this.session.sendOneShot({
            type: MiniappRequestType.NAVIGATION_DEVIATE,
            offsetMeters
          });
        },
        setWrongSidewalkOffset: (enabled) => {
          this.session.sendOneShot({
            type: MiniappRequestType.NAVIGATION_SET_WRONG_SIDEWALK,
            enabled
          });
        },
        setSkipCrossings: (enabled) => {
          this.session.sendOneShot({
            type: MiniappRequestType.NAVIGATION_SET_SKIP_CROSSINGS,
            enabled
          });
        }
      };
    }
    onUpdate(handler) {
      return this.session._subscribe(MiniappStreamType.NAVIGATION_UPDATE, handler);
    }
    onRoute(handler) {
      return this.session._subscribe(MiniappStreamType.NAVIGATION_ROUTE, handler);
    }
    async getState() {
      const result = await this.session.sendRequest({
        type: MiniappRequestType.NAVIGATION_GET_STATE
      });
      return result.ok ? result.state ?? null : null;
    }
    computeRoute(opts) {
      if (!this.hasPermission) {
        return Promise.resolve({
          ok: false,
          error: "LOCATION permission not declared in miniapp.json (required for navigation.computeRoute)."
        });
      }
      return this.session.sendRequest({
        type: MiniappRequestType.NAVIGATION_COMPUTE_ROUTE,
        origin: opts.origin,
        stops: opts.stops,
        mode: opts.mode ?? "driving",
        avoid: opts.avoid,
        alternatives: opts.alternatives ?? 1
      });
    }
    onPivot(handler) {
      return this._pivots.subscribe(handler);
    }
    getPivots() {
      return this._pivots.getPivots();
    }
    getActivePivot() {
      return this._pivots.getActivePivot();
    }
    getUpcomingPivot() {
      return this._pivots.getUpcomingPivot();
    }
    _attachPivotTrackingForTrip(mode, opts) {
      this._detachPivotTracking();
      this._pivots.reset();
      this._pivots.updateOptions(mode, opts);
      this._tripUnsubs.push(this.onRoute((route) => {
        this._pivots.setRoute(route, null);
      }));
      this._tripUnsubs.push(this.onUpdate((update) => {
        if (update.kind === "arrived") {
          this._pivots.reset();
        }
      }));
      this._tripUnsubs.push(this.session.location.onUpdate((loc) => {
        this._pivots.onLocationUpdate({ lat: loc.lat, lng: loc.lng });
      }));
    }
    _detachPivotTracking() {
      for (const unsub of this._tripUnsubs) {
        try {
          unsub();
        } catch (err) {
          console.warn("[NavigationModule] pivot-tracking unsubscribe threw:", err);
        }
      }
      this._tripUnsubs = [];
      this._pivots.reset();
    }
  }
  function normalizeStops(opts) {
    if (opts.stops && opts.stops.length > 0) {
      return opts.stops;
    }
    if (typeof opts.lat === "number" && typeof opts.lng === "number") {
      return [{ lat: opts.lat, lng: opts.lng }];
    }
    return [];
  }

  // ../../mobile/modules/miniapp/dist/modules/permissions.js
  class PermissionsModule {
    constructor(session) {
      this.session = session;
    }
    has(type) {
      return this.session._getPermissions()[type] === true;
    }
    getAll() {
      return this.session._getPermissions();
    }
    onUpdate(handler) {
      return this.session.on("permissions", handler);
    }
    onPermissionError(handler) {
      return this.session.on("error", (e) => {
        const maybe = e;
        if (maybe?.code === MiniappErrorCode.PERMISSION_NOT_DECLARED) {
          handler({
            code: String(maybe.code),
            message: String(maybe.message ?? ""),
            permission: maybe.permission,
            subscription: maybe.subscription,
            operation: maybe.operation
          });
        }
      });
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/phone.js
  class TrackedSubs {
    constructor() {
      this.unsubs = new Set;
    }
    track(unsub) {
      this.unsubs.add(unsub);
      return () => {
        this.unsubs.delete(unsub);
        unsub();
      };
    }
    stop() {
      for (const u of this.unsubs) {
        try {
          u();
        } catch {}
      }
      this.unsubs.clear();
    }
  }

  class PhoneNotificationsModule extends TrackedSubs {
    constructor(session) {
      super();
      this.session = session;
    }
    on(handler) {
      return this.track(this.session._subscribe(MiniappStreamType.PHONE_NOTIFICATION, handler));
    }
    onDismissed(handler) {
      return this.track(this.session._subscribe(MiniappStreamType.PHONE_NOTIFICATION_DISMISSED, handler));
    }
    get hasPermission() {
      return this.session._hasManifestPermission("READ_NOTIFICATIONS");
    }
  }

  class PhoneCalendarModule extends TrackedSubs {
    constructor(session) {
      super();
      this.session = session;
    }
    on(handler) {
      return this.track(this.session._subscribe(MiniappStreamType.CALENDAR_EVENT, handler));
    }
    get hasPermission() {
      return this.session._hasManifestPermission("CALENDAR");
    }
  }

  class PhoneModule {
    constructor(session) {
      this.session = session;
      this.notifications = new PhoneNotificationsModule(session);
      this.calendar = new PhoneCalendarModule(session);
    }
    onBattery(handler) {
      return this.session._subscribe(MiniappStreamType.PHONE_BATTERY, handler);
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/transcription.js
  class TranscriptionModule {
    constructor(session) {
      this.session = session;
      this.unsubs = new Set;
      this.currentConfig = null;
    }
    on(handler) {
      return this.track(this.session._subscribe(`${MiniappStreamType.TRANSCRIPTION}:auto`, handler));
    }
    forLanguage(language, handler) {
      const langs = Array.isArray(language) ? language : [language];
      if (langs.length === 0)
        return () => {};
      const unsubs = [];
      for (const lang of langs) {
        unsubs.push(this.session._subscribe(`${MiniappStreamType.TRANSCRIPTION}:${lang}`, handler));
      }
      const combined = () => {
        for (const u of unsubs) {
          try {
            u();
          } catch {}
        }
      };
      return this.track(combined);
    }
    configure(config) {
      this.currentConfig = { ...config };
      this.session.sendOneShot({
        type: MiniappRequestType.TRANSCRIPTION_CONFIG,
        config: { ...config }
      });
    }
    stop() {
      for (const u of this.unsubs) {
        try {
          u();
        } catch {}
      }
      this.unsubs.clear();
    }
    get hasPermission() {
      return this.session._hasManifestPermission("MICROPHONE");
    }
    _getConfig() {
      return this.currentConfig ? { ...this.currentConfig } : null;
    }
    track(unsub) {
      this.unsubs.add(unsub);
      return () => {
        this.unsubs.delete(unsub);
        unsub();
      };
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/translation.js
  class TranslationModule {
    constructor(session) {
      this.session = session;
      this.unsubs = new Set;
    }
    on(handler) {
      return this.track(this.session._subscribe(`${MiniappStreamType.TRANSLATION}:*:*`, handler));
    }
    to(target, handler) {
      const targets = Array.isArray(target) ? target : [target];
      if (targets.length === 0)
        return () => {};
      const unsubs = [];
      for (const t of targets) {
        unsubs.push(this.session._subscribe(`${MiniappStreamType.TRANSLATION}:*:${t}`, handler));
      }
      const composite = () => {
        for (const u of unsubs) {
          try {
            u();
          } catch {}
        }
      };
      return this.track(composite);
    }
    fromTo(source, target, handler) {
      const targets = Array.isArray(target) ? target : [target];
      if (targets.length === 0)
        return () => {};
      const unsubs = [];
      for (const t of targets) {
        unsubs.push(this.session._subscribe(`${MiniappStreamType.TRANSLATION}:${source}:${t}`, handler));
      }
      const composite = () => {
        for (const u of unsubs) {
          try {
            u();
          } catch {}
        }
      };
      return this.track(composite);
    }
    forLanguagePair(fromLang, toLang, handler) {
      return this.fromTo(fromLang, toLang, handler);
    }
    stop() {
      for (const u of this.unsubs) {
        try {
          u();
        } catch {}
      }
      this.unsubs.clear();
    }
    get hasPermission() {
      return this.session._hasManifestPermission("MICROPHONE");
    }
    track(unsub) {
      this.unsubs.add(unsub);
      return () => {
        this.unsubs.delete(unsub);
        unsub();
      };
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/ui.js
  function rpcErrorFromUnknown(e) {
    if (e instanceof Error) {
      const cause = e.cause;
      const code = cause?.code;
      return code ? { message: e.message, code } : { message: e.message };
    }
    return { message: String(e) };
  }

  class UIModuleImpl {
    constructor(session) {
      this.session = session;
      this.bound = false;
      this.nextSeq = 1;
      this.openHandlers = new Set;
      this.closeHandlers = new Set;
      this.channelHandlers = new Map;
      this.rpcHandlers = new Map;
      this.inflightRpc = new Map;
      this.isOpen = () => {
        return this.bound;
      };
      this.onOpen = (cb) => {
        this.openHandlers.add(cb);
        if (this.bound) {
          try {
            cb();
          } catch (e) {
            console.warn("session.ui.onOpen late-fire threw:", e);
          }
        }
        return () => {
          this.openHandlers.delete(cb);
        };
      };
      this.onClose = (cb) => {
        this.closeHandlers.add(cb);
        return () => {
          this.closeHandlers.delete(cb);
        };
      };
      this.send = (channel, payload) => {
        if (!this.bound) {
          return;
        }
        const seq = this.nextSeq++;
        const envelope = { type: "UI_SEND", channel, payload, seq };
        this.session.sendOneShot(envelope);
      };
      this.on = (channel, cb) => {
        let set = this.channelHandlers.get(channel);
        if (!set) {
          set = new Set;
          this.channelHandlers.set(channel, set);
        }
        set.add(cb);
        return () => {
          set.delete(cb);
        };
      };
      this.handle = (channel, handler) => {
        const key = channel;
        if (this.rpcHandlers.has(key)) {
          throw new Error(`session.ui.handle: a handler is already registered for "${key}"`);
        }
        this.rpcHandlers.set(key, handler);
        return () => {
          this.rpcHandlers.delete(key);
        };
      };
      this.session._subscribe("_ui", (env) => this.handleInbound(env));
    }
    handleInbound(env) {
      if (env.type === "UI_OPEN") {
        this.bound = true;
        this.nextSeq = 1;
        for (const h of this.openHandlers) {
          try {
            h();
          } catch (e) {
            console.warn("session.ui.onOpen handler threw", e);
          }
        }
        return;
      }
      if (env.type === "UI_CLOSE") {
        this.bound = false;
        for (const h of this.closeHandlers) {
          try {
            h();
          } catch (e) {
            console.warn("session.ui.onClose handler threw", e);
          }
        }
        return;
      }
      if (env.type === "UI_MESSAGE") {
        if (typeof env.requestId === "string") {
          this.dispatchRpcCall(env.channel, env.payload, env.requestId);
          return;
        }
        const set = this.channelHandlers.get(env.channel);
        if (!set || set.size === 0)
          return;
        for (const h of set) {
          try {
            h(env.payload);
          } catch (e) {
            console.warn(`session.ui.on(${env.channel}) threw`, e);
          }
        }
        return;
      }
      if (env.type === "UI_CANCEL") {
        const ctrl = this.inflightRpc.get(env.requestId);
        if (ctrl) {
          try {
            ctrl.abort();
          } catch {}
        }
        return;
      }
    }
    dispatchRpcCall(channel, payload, requestId) {
      const handler = this.rpcHandlers.get(channel);
      if (!handler) {
        this.sendRpcReply(channel, requestId, {
          ok: false,
          error: { message: `no handler registered for "${channel}"` }
        });
        return;
      }
      const ctrl = new AbortController;
      this.inflightRpc.set(requestId, ctrl);
      const ctx = { signal: ctrl.signal };
      const finish = (envelope) => {
        this.inflightRpc.delete(requestId);
        if (ctrl.signal.aborted)
          return;
        this.sendRpcReply(channel, requestId, envelope);
      };
      let result;
      try {
        result = handler(payload, ctx);
      } catch (e) {
        finish({ ok: false, error: rpcErrorFromUnknown(e) });
        return;
      }
      if (result && typeof result.then === "function") {
        result.then((v) => finish({ ok: true, result: v }), (e) => finish({ ok: false, error: rpcErrorFromUnknown(e) }));
      } else {
        finish({ ok: true, result });
      }
    }
    sendRpcReply(channel, requestId, payload) {
      if (!this.bound)
        return;
      const seq = this.nextSeq++;
      const envelope = { type: "UI_SEND", channel, payload, seq, requestId };
      this.session.sendOneShot(envelope);
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/storage.js
  class SimpleStorage {
    constructor(session) {
      this.session = session;
    }
    async get(key) {
      const result = await this.session.sendRequest({
        type: MiniappRequestType.STORAGE_GET,
        key
      });
      return result?.value ?? null;
    }
    async set(key, value) {
      await this.session.sendRequest({
        type: MiniappRequestType.STORAGE_SET,
        key,
        value
      });
    }
    async delete(key) {
      await this.session.sendRequest({
        type: MiniappRequestType.STORAGE_DELETE,
        key
      });
    }
    async keys() {
      const result = await this.session.sendRequest({
        type: MiniappRequestType.STORAGE_LIST
      });
      return result?.keys ?? [];
    }
    async list() {
      return this.keys();
    }
    async clear() {
      await this.session.sendRequest({
        type: MiniappRequestType.STORAGE_CLEAR
      });
    }
    async has(key) {
      const result = await this.session.sendRequest({
        type: MiniappRequestType.STORAGE_HAS,
        key
      });
      return !!result?.has;
    }
    async getAll() {
      const result = await this.session.sendRequest({
        type: MiniappRequestType.STORAGE_GET_ALL
      });
      return result?.values ?? {};
    }
    async setMultiple(values) {
      await this.session.sendRequest({
        type: MiniappRequestType.STORAGE_SET_MULTIPLE,
        values
      });
    }
    async flush() {
      await this.session.sendRequest({
        type: MiniappRequestType.STORAGE_FLUSH
      });
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/speaker.js
  class SpeakerModule {
    constructor(session) {
      this.session = session;
      this._state = "idle";
      this._lastEvent = { state: "idle" };
    }
    get state() {
      return this._state;
    }
    get isPlaying() {
      return this._state === "playing";
    }
    async play(options) {
      await this.session.sendRequest({
        type: MiniappRequestType.PLAY_AUDIO,
        audioUrl: options.audioUrl,
        volume: options.volume,
        stopOtherAudio: options.stopOtherAudio ?? false
      });
    }
    async speak(text, options = {}) {
      try {
        const result = await this.session.sendRequest({
          type: MiniappRequestType.SPEAK,
          text,
          voice_id: options.voice_id,
          voice_settings: options.voice_settings,
          volume: options.volume,
          stopOtherAudio: options.stopOtherAudio ?? false
        });
        return result ?? { completed: true };
      } catch (err) {
        if (err && typeof err === "object" && "code" in err) {
          throw err;
        }
        throw { code: MiniappErrorCode.INTERNAL, message: String(err) };
      }
    }
    stop() {
      this.session.sendOneShot({ type: MiniappRequestType.STOP_AUDIO });
    }
    onStateChange(handler) {
      return this.session.on("speakerState", handler);
    }
    _applyState(event) {
      if (event.state === this._state && event.state !== "error")
        return;
      this._state = event.state;
      this._lastEvent = event;
    }
    _getLastEvent() {
      return { ...this._lastEvent };
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/stream.js
  class StreamModule {
    constructor(session) {
      this.session = session;
    }
    async startUnmanaged(options) {
      const result = await this.session.sendRequest({
        type: MiniappRequestType.STREAM_START,
        streamUrl: options.streamUrl,
        video: options.video ?? true,
        audio: options.audio ?? true
      });
      return result?.streamId ?? "";
    }
    async startManaged(options = {}) {
      const result = await this.session.sendRequest({
        type: MiniappRequestType.MANAGED_STREAM_START,
        restreamDestinations: options.restreamDestinations
      });
      return result ?? { streamId: "" };
    }
    async stop(streamId) {
      await this.session.sendRequest({
        type: MiniappRequestType.STREAM_STOP,
        streamId
      });
    }
  }

  // ../../mobile/modules/miniapp/dist/modules/system.js
  class SystemModule {
    constructor(session) {
      this.session = session;
    }
    async share(options) {
      const result = await this.session.sendRequest({
        type: MiniappRequestType.SHARE,
        ...options
      });
      return result ?? { success: false };
    }
    openUrl(url) {
      this.session.sendOneShot({
        type: MiniappRequestType.OPEN_URL,
        url
      });
    }
    async copyToClipboard(text) {
      await this.session.sendRequest({
        type: MiniappRequestType.COPY_CLIPBOARD,
        text
      });
    }
    async download(options) {
      const result = await this.session.sendRequest({
        type: MiniappRequestType.DOWNLOAD,
        ...options
      });
      return result ?? { success: false };
    }
  }

  // ../../mobile/modules/miniapp/dist/session.js
  var ALL_PERMISSION_TYPES = [
    "location",
    "microphone",
    "camera",
    "notifications",
    "calendar"
  ];

  class NotConnectedError extends Error {
    constructor(message = "MiniappSession is not connected") {
      super(message);
      this.code = MiniappErrorCode.NOT_CONNECTED;
      this.name = "NotConnectedError";
    }
  }
  var DEFAULT_CONNECT_TIMEOUT_MS = 1e4;

  class MiniappSession {
    constructor(options = {}) {
      this.capabilities = null;
      this.userId = "";
      this.packageName = "";
      this.visibility = "foreground";
      this.colorScheme = "light";
      this.ready = false;
      this.emitter = new import__.default;
      this.outboundQueue = [];
      this.pendingRequests = new Map;
      this.connectPromise = null;
      this.disposed = false;
      this._permissions = {
        location: false,
        microphone: false,
        camera: false,
        notifications: false,
        calendar: false
      };
      this.transport = createTransport(options);
      this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      const injected = getMentraOSGlobals();
      this.packageName = options.packageName ?? injected.packageName ?? "";
      if (injected.colorScheme === "light" || injected.colorScheme === "dark") {
        this.colorScheme = injected.colorScheme;
      }
      this.events = new EventManager(this);
      this.speaker = new SpeakerModule(this);
      this.camera = new CameraModule(this);
      this.dashboard = new DashboardAPI(this);
      this.display = new DisplayManager(this);
      this.glasses = new GlassesModule(this);
      this.heading = new HeadingModule(this);
      this.imu = new ImuModule(this);
      this.input = new InputModule(this);
      this.led = new LedModule(this);
      this.location = new LocationModule(this);
      this.mic = new MicModule(this);
      this.navigation = new NavigationModule(this);
      this.permissions = new PermissionsModule(this);
      this.phone = new PhoneModule(this);
      this.storage = new SimpleStorage(this);
      this.stream = new StreamModule(this);
      this.system = new SystemModule(this);
      this.transcription = new TranscriptionModule(this);
      this.translation = new TranslationModule(this);
      this.ui = new UIModuleImpl(this);
    }
    _hasManifestPermission(manifestKey) {
      const canonical = manifestKeyToCanonical(manifestKey);
      if (!canonical)
        return false;
      return this._permissions[canonical] === true;
    }
    _getPermissions() {
      return { ...this._permissions };
    }
    _subscribe(streamType, handler) {
      return this.events.subscribe(streamType, handler);
    }
    connect() {
      if (this.disposed) {
        return Promise.reject(new NotConnectedError("MiniappSession was disposed"));
      }
      if (this.connectPromise)
        return this.connectPromise;
      const readyPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const err = new Error("MiniappSession: CONNECT_ACK timeout");
          this.failAllPending({ code: MiniappErrorCode.NOT_CONNECTED, message: err.message });
          this.emitter.emit("error", err);
          reject(err);
        }, this.connectTimeoutMs);
        this.emitter.once("ready", () => {
          clearTimeout(timer);
          resolve();
        });
        this.emitter.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      this.connectPromise = (async () => {
        this.transport.onMessage((raw) => this.handleIncoming(raw));
        this.transport.onDisconnect((reason) => this.handleTransportDisconnect(reason));
        await this.transport.open();
        const requestId = makeRequestId();
        const connectPayload = {
          type: MiniappRequestType.CONNECT,
          packageName: this.packageName
        };
        this.transport.send(serializeEnvelope({ payload: connectPayload, requestId }));
        await readyPromise;
      })();
      return this.connectPromise;
    }
    waitForReady() {
      if (this.ready)
        return Promise.resolve();
      return this.connect();
    }
    isConnected() {
      return this.ready && this.transport.isOpen();
    }
    disconnect() {
      if (this.disposed)
        return;
      this.disposed = true;
      try {
        this.emitter.emit("beforeDisconnect", "disconnect called");
      } catch (err) {
        console.warn("[MiniappSession] beforeDisconnect handler threw:", err);
      }
      this.failAllPending({ code: MiniappErrorCode.REQUEST_ABORTED, message: "Session disconnected" });
      try {
        this.transport.close();
      } catch {}
      this.ready = false;
      this.emitter.emit("disconnect", "disconnect called");
    }
    sendOneShot(payload) {
      const envelope = { payload };
      this.enqueueOrSend(serializeEnvelope(envelope));
    }
    sendRequest(payload) {
      if (this.disposed) {
        return Promise.reject(new NotConnectedError);
      }
      const requestId = makeRequestId();
      const envelope = { payload, requestId };
      return new Promise((resolve, reject) => {
        this.pendingRequests.set(requestId, {
          requestId,
          resolve,
          reject
        });
        this.enqueueOrSend(serializeEnvelope(envelope));
      });
    }
    on(event, handler) {
      this.emitter.on(event, handler);
      return () => this.emitter.off(event, handler);
    }
    off(event, handler) {
      this.emitter.off(event, handler);
    }
    onBeforeDisconnect(handler) {
      return this.on("beforeDisconnect", handler);
    }
    onVisibilityChange(handler) {
      return this.on("visibility", handler);
    }
    onCapabilitiesChange(handler) {
      return this.on("capabilities", handler);
    }
    onColorSchemeChange(handler) {
      return this.on("colorScheme", handler);
    }
    enqueueOrSend(raw) {
      if (this.ready) {
        try {
          this.transport.send(raw);
        } catch (err) {
          this.emitter.emit("error", err);
        }
        return;
      }
      this.outboundQueue.push(raw);
    }
    flushQueue() {
      const queue = this.outboundQueue.splice(0);
      for (const raw of queue) {
        try {
          this.transport.send(raw);
        } catch (err) {
          this.emitter.emit("error", err);
        }
      }
    }
    handleIncoming(raw) {
      const envelope = parseEnvelope(raw);
      if (!envelope)
        return;
      const payload = envelope.payload;
      const type = payload?.type;
      switch (type) {
        case MiniappResponseType.CONNECT_ACK: {
          const ack = payload;
          this.userId = ack.userId ?? "";
          if (ack.packageName)
            this.packageName = ack.packageName;
          this.capabilities = ack.capabilities ?? null;
          if (ack.visibility)
            this.visibility = ack.visibility;
          if (ack.colorScheme === "light" || ack.colorScheme === "dark") {
            this.colorScheme = ack.colorScheme;
          }
          if (ack.permissions)
            this.applyPermissions(ack.permissions);
          this.ready = true;
          this.flushQueue();
          this.emitter.emit("ready");
          return;
        }
        case MiniappResponseType.PERMISSIONS_UPDATE: {
          const next = payload.permissions;
          if (next)
            this.applyPermissions(next);
          return;
        }
        case MiniappResponseType.SPEAKER_STATE: {
          const state = payload.state;
          if (!state)
            return;
          const event = {
            state,
            errorCode: payload.errorCode,
            errorMessage: payload.errorMessage,
            durationMs: payload.durationMs
          };
          this.speaker._applyState(event);
          this.emitter.emit("speakerState", event);
          return;
        }
        case MiniappRequestType.PING: {
          const pong = { type: MiniappResponseType.PONG };
          const env = {
            payload: pong,
            ...envelope.requestId ? { requestId: envelope.requestId } : {}
          };
          try {
            this.transport.send(serializeEnvelope(env));
          } catch {}
          return;
        }
        case MiniappResponseType.EVENT: {
          const streamType = payload.streamType;
          if (!streamType)
            return;
          this.events._forwardEvent(streamType, payload.data);
          return;
        }
        case MiniappResponseType.CAPABILITIES_UPDATE: {
          const cap = payload.capabilities ?? null;
          this.capabilities = cap;
          this.emitter.emit("capabilities", cap);
          return;
        }
        case MiniappResponseType.VISIBILITY_CHANGE: {
          const next = payload.visibility;
          if (next === "foreground" || next === "background") {
            this.visibility = next;
            this.emitter.emit("visibility", next);
          }
          return;
        }
        case MiniappResponseType.COLOR_SCHEME_CHANGE: {
          const next = payload.colorScheme;
          if (next === "light" || next === "dark") {
            this.colorScheme = next;
            this.emitter.emit("colorScheme", next);
          }
          return;
        }
        case MiniappResponseType.REQUEST_RESULT: {
          const requestId = envelope.requestId;
          if (!requestId)
            return;
          const pending = this.pendingRequests.get(requestId);
          if (!pending)
            return;
          this.pendingRequests.delete(requestId);
          if (payload.ok === false) {
            const err = payload.error ?? {
              code: MiniappErrorCode.INTERNAL,
              message: "Unknown error"
            };
            pending.reject(err);
          } else {
            pending.resolve(payload.data ?? null);
          }
          return;
        }
        case MiniappResponseType.WILL_DISCONNECT: {
          const reason = payload.reason ?? "phone unregistering";
          try {
            this.emitter.emit("beforeDisconnect", reason);
          } catch (err) {
            console.warn("[MiniappSession] beforeDisconnect handler threw:", err);
          }
          return;
        }
        case MiniappResponseType.ERROR: {
          const err = new Error(payload.message ?? "MiniappSession error");
          this.emitter.emit("error", err);
          return;
        }
        default:
          return;
      }
    }
    handleTransportDisconnect(reason) {
      this.ready = false;
      this.failAllPending({ code: MiniappErrorCode.NOT_CONNECTED, message: `Transport disconnected: ${reason}` });
      this.emitter.emit("disconnect", reason);
    }
    failAllPending(error) {
      for (const pending of this.pendingRequests.values()) {
        pending.reject(error);
      }
      this.pendingRequests.clear();
    }
    applyPermissions(next) {
      let changed = false;
      const updated = { ...this._permissions };
      for (const k of ALL_PERMISSION_TYPES) {
        const v = next[k] === true;
        if (updated[k] !== v) {
          updated[k] = v;
          changed = true;
        }
      }
      if (changed) {
        this._permissions = updated;
        this.emitter.emit("permissions", { ...updated });
      }
    }
  }
  function manifestKeyToCanonical(manifestKey) {
    switch (manifestKey.toUpperCase()) {
      case "MICROPHONE":
        return "microphone";
      case "CAMERA":
        return "camera";
      case "LOCATION":
      case "BACKGROUND_LOCATION":
        return "location";
      case "READ_NOTIFICATIONS":
      case "POST_NOTIFICATIONS":
        return "notifications";
      case "CALENDAR":
        return "calendar";
      default:
        return null;
    }
  }

  // ../../mobile/modules/miniapp/dist/background/register.js
  function registerMiniapp(handler, options = {}) {
    const g = globalThis;
    g.__mentraInitCallback = (_sessionId) => {
      const session = new MiniappSession(options);
      try {
        const result = handler(session);
        if (result && typeof result.then === "function") {
          result.catch((err) => {
            console.error("[mentra-miniapp] registerMiniapp handler rejected:", err);
          });
        }
      } catch (err) {
        console.error("[mentra-miniapp] registerMiniapp handler threw:", err);
      }
      session.connect().catch((err) => {
        console.error("[mentra-miniapp] session.connect() rejected:", err);
        try {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error && err.stack ? err.stack : "";
          g.__hostError?.(JSON.stringify({ message: `session.connect() failed: ${message}`, stack }));
        } catch {}
      });
    };
  }
  // src/background/managers/CompassManager.ts
  class CompassManager {
    session;
    constructor(session) {
      this.session = session;
    }
    onUpdate(handler) {
      return this.session.heading.onUpdate(handler);
    }
  }

  // src/background/managers/DisplayManager.ts
  class DisplayManager2 {
    session;
    constructor(session) {
      this.session = session;
    }
    showText(text, durationMs) {
      this.safeCall(() => this.session.display.showTextWall(text, durationMs != null ? { durationMs } : undefined));
    }
    clear() {
      this.safeCall(() => this.session.display.clearView());
    }
    safeCall(fn) {
      try {
        fn();
      } catch (err) {
        console.log("[NAV-MINI] display call ignored:", err);
      }
    }
  }

  // src/background/managers/LocationManager.ts
  class LocationManager {
    session;
    constructor(session) {
      this.session = session;
    }
    onUpdate(handler) {
      return this.session.location.onUpdate(handler);
    }
    getOnce() {
      return this.session.location.getOnce();
    }
  }

  // src/background/lib/formatDistance.ts
  function formatDistance(meters) {
    if (meters < 0)
      return "—";
    if (meters < 1000)
      return `${Math.max(1, Math.round(meters))} m`;
    const km = meters / 1000;
    return `${km.toFixed(km < 10 ? 1 : 0)} km`;
  }
  function formatDuration(seconds) {
    if (seconds < 0)
      return "—";
    if (seconds < 60)
      return `${seconds} sec`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
      return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const remMin = minutes % 60;
    return remMin === 0 ? `${hours} h` : `${hours} h ${remMin} min`;
  }

  // src/background/managers/ManeuverFormatter.ts
  var IMMINENT_M = 30;

  class ManeuverFormatter {
    isStraight(m) {
      return !!m && (m.maneuverType === "STRAIGHT" || m.maneuverType === "CONTINUE");
    }
    cap(s) {
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    glyph(type) {
      switch (type.toUpperCase()) {
        case "TURN_LEFT":
          return "↰";
        case "TURN_RIGHT":
          return "↱";
        case "SLIGHT_LEFT":
          return "↖";
        case "SLIGHT_RIGHT":
          return "↗";
        case "SHARP_LEFT":
          return "⤴";
        case "SHARP_RIGHT":
          return "⤵";
        case "U_TURN":
          return "↶";
        case "STRAIGHT":
        case "CONTINUE":
          return "↑";
        case "ARRIVE":
          return "●";
        case "CROSS_STREET":
          return "⇆";
        default:
          return "↑";
      }
    }
    arrow(type) {
      const t = type.toUpperCase();
      if (t === "CROSS_STREET")
        return "⇆";
      if (t.includes("LEFT"))
        return "←";
      if (t.includes("RIGHT"))
        return "→";
      if (t === "U_TURN")
        return "↺";
      return "↑";
    }
    humanize(type) {
      switch (type.toUpperCase()) {
        case "TURN_LEFT":
          return "turn left";
        case "TURN_RIGHT":
          return "turn right";
        case "SLIGHT_LEFT":
          return "slight left";
        case "SLIGHT_RIGHT":
          return "slight right";
        case "SHARP_LEFT":
          return "sharp left";
        case "SHARP_RIGHT":
          return "sharp right";
        case "U_TURN":
          return "make a U-turn";
        case "STRAIGHT":
        case "CONTINUE":
          return "continue straight";
        case "ARRIVE":
          return "arrive";
        case "CROSS_STREET":
          return "cross the road";
        default:
          return type.toLowerCase().replace(/_/g, " ");
      }
    }
    headline(m) {
      const verb = this.humanize(m.maneuverType);
      if (m.maneuverType === "ARRIVE") {
        return m.distanceMeters > 0 ? `Arriving in ${formatDistance(m.distanceMeters)}` : "Arriving";
      }
      if (m.maneuverType === "STRAIGHT") {
        return "Continue straight";
      }
      if (m.distanceMeters > 0) {
        return `In ${formatDistance(m.distanceMeters)}, ${verb}`;
      }
      return this.cap(verb);
    }
    glassesLines(m) {
      const dist = m.distanceMeters;
      const isStraightT = this.isStraight(m);
      const arrowed = (verb2) => `${this.arrow(m.maneuverType)} ${verb2}`;
      const toRoad = this.cleanRoad(m.toRoad, m.maneuverType);
      if (!isStraightT && dist >= 0 && dist <= IMMINENT_M) {
        const verb2 = this.humanize(m.maneuverType);
        const onto2 = m.maneuverType === "CROSS_STREET" || !toRoad ? "" : ` onto ${toRoad}`;
        return { now: arrowed(`${this.cap(verb2)}${onto2}`), next: null };
      }
      const road = this.cleanRoad(m.fromRoad, m.maneuverType);
      const distStr = dist > 0 ? formatDistance(dist) : null;
      const nowLine = road && distStr ? `↑ ${road} • ${distStr}` : road ? `↑ ${road}` : distStr ? `↑ Continue ${distStr}` : "↑ Continue";
      if (isStraightT) {
        return { now: nowLine, next: null };
      }
      const verb = this.humanize(m.maneuverType);
      const onto = m.maneuverType === "CROSS_STREET" || !toRoad ? "" : ` onto ${toRoad}`;
      return { now: nowLine, next: arrowed(`Then ${verb}${onto}`) };
    }
    glassesProgressLine(m) {
      const dist = m.distanceToDestinationMeters;
      const time = m.timeToDestinationSeconds;
      const haveDist = typeof dist === "number" && dist >= 0;
      const haveTime = typeof time === "number" && time >= 0;
      if (!haveDist && !haveTime)
        return null;
      const distStr = haveDist ? `${formatDistance(dist)} to destination` : null;
      const timeStr = haveTime ? formatDuration(time) : null;
      return [distStr, timeStr].filter(Boolean).join(" · ");
    }
    cleanRoad(road, maneuverType) {
      const trimmed = road?.trim();
      if (!trimmed)
        return null;
      const verb = this.humanize(maneuverType).toLowerCase();
      const lower = trimmed.toLowerCase();
      if (lower === verb || lower.startsWith(verb))
        return null;
      return trimmed;
    }
  }

  // src/background/managers/NavigationManager.ts
  class NavigationManager {
    session;
    format = new ManeuverFormatter;
    constructor(session) {
      this.session = session;
    }
    get hasPermission() {
      return this.session.navigation.hasPermission;
    }
    requestPermission() {
      return this.session.navigation.requestPermission();
    }
    start(opts) {
      return this.session.navigation.start(opts);
    }
    stop() {
      this.session.navigation.stop();
    }
    get dev() {
      return this.session.navigation.dev;
    }
    onUpdate(handler) {
      return this.session.navigation.onUpdate(handler);
    }
    onRoute(handler) {
      return this.session.navigation.onRoute(handler);
    }
    getState() {
      return this.session.navigation.getState();
    }
    computeRoute(opts) {
      return this.session.navigation.computeRoute(opts);
    }
    onPivot(handler) {
      return this.session.navigation.onPivot(handler);
    }
    getPivots() {
      return this.session.navigation.getPivots();
    }
    getActivePivot() {
      return this.session.navigation.getActivePivot();
    }
    getUpcomingPivot() {
      return this.session.navigation.getUpcomingPivot();
    }
  }

  // src/background/lib/places.ts
  var cachedKeyPromise = null;
  async function getApiKey() {
    if (cachedKeyPromise)
      return cachedKeyPromise;
    cachedKeyPromise = (async () => {
      try {
        const fromEnv = "AIzaSyDicMgKU1XfWTSNbC9IL1eK0WiZKS-crCo";
        if (fromEnv)
          return fromEnv;
      } catch {}
      try {
        const res = await fetch("/api/config");
        if (res.ok) {
          const { googlePlacesApiKey } = await res.json();
          return googlePlacesApiKey ?? "";
        }
      } catch {}
      return "";
    })();
    return cachedKeyPromise;
  }

  class PlacesSession {
    token;
    constructor() {
      this.token = newToken();
    }
    async autocomplete(input, signal) {
      if (!input.trim())
        return [];
      const key = await getApiKey();
      if (!key)
        throw new Error("missing EXPO_PUBLIC_GOOGLE_PLACES_API_KEY");
      const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key
        },
        body: JSON.stringify({ input, sessionToken: this.token }),
        signal
      });
      if (!res.ok)
        throw new Error(`autocomplete ${res.status}`);
      const json = await res.json();
      return (json.suggestions ?? []).map((s) => s.placePrediction).filter((p) => !!p).map((p) => ({
        placeId: p.placeId,
        mainText: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
        secondaryText: p.structuredFormat?.secondaryText?.text ?? ""
      }));
    }
    async details(placeId, signal) {
      const key = await getApiKey();
      if (!key)
        throw new Error("missing EXPO_PUBLIC_GOOGLE_PLACES_API_KEY");
      const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(this.token)}`;
      const res = await fetch(url, {
        headers: {
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "id,location,displayName,formattedAddress"
        },
        signal
      });
      if (!res.ok)
        throw new Error(`details ${res.status}`);
      const json = await res.json();
      if (!json.location)
        throw new Error("details: no location");
      return {
        placeId: json.id ?? placeId,
        lat: json.location.latitude,
        lng: json.location.longitude,
        name: json.displayName?.text ?? "",
        address: json.formattedAddress ?? ""
      };
    }
    reset() {
      this.token = newToken();
    }
  }
  function newToken() {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // src/background/managers/PlacesManager.ts
  class PlacesManager {
    session = new PlacesSession;
    autocomplete(query, near, signal) {
      return this.session.autocomplete(query, signal);
    }
    async details(placeId, signal) {
      const result = await this.session.details(placeId, signal);
      this.session.reset();
      return result;
    }
  }

  // src/background/managers/SimpleStorageManager.ts
  class SimpleStorageManager {
    session;
    constructor(session) {
      this.session = session;
    }
    get(key) {
      return this.session.storage.get(key);
    }
    set(key, value) {
      return this.session.storage.set(key, value);
    }
    delete(key) {
      return this.session.storage.delete(key);
    }
    list() {
      return this.session.storage.list();
    }
    async getJSON(key) {
      const raw = await this.session.storage.get(key);
      if (raw === null)
        return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    setJSON(key, value) {
      return this.session.storage.set(key, JSON.stringify(value));
    }
    static RECENT_SEARCHES_KEY = "recentSearches";
    static RECENT_SEARCHES_MAX = 10;
    async getRecentSearches() {
      return await this.getJSON(SimpleStorageManager.RECENT_SEARCHES_KEY) ?? [];
    }
    async addRecentSearch(place) {
      const current = await this.getRecentSearches();
      const next = [place, ...current.filter((p) => p.placeId !== place.placeId)].slice(0, SimpleStorageManager.RECENT_SEARCHES_MAX);
      await this.setJSON(SimpleStorageManager.RECENT_SEARCHES_KEY, next);
    }
    static SAVED_PLACES_KEY = "savedPlaces";
    static SAVED_MAX = 20;
    async getAllSavedPlaces() {
      return await this.getJSON(SimpleStorageManager.SAVED_PLACES_KEY) ?? [];
    }
    async addSavedPlace(place) {
      const current = await this.getAllSavedPlaces();
      const filtered = current.filter((p) => {
        if (place.type && p.type === place.type)
          return false;
        if (p.placeId === place.placeId)
          return false;
        return true;
      });
      const next = [place, ...filtered].slice(0, SimpleStorageManager.SAVED_MAX);
      await this.setJSON(SimpleStorageManager.SAVED_PLACES_KEY, next);
    }
    async removeSavedPlace(placeId) {
      const current = await this.getAllSavedPlaces();
      const next = current.filter((p) => p.placeId !== placeId);
      if (next.length !== current.length) {
        await this.setJSON(SimpleStorageManager.SAVED_PLACES_KEY, next);
      }
    }
  }

  // src/background/lib/geometry.ts
  function haversineMeters2(a, b) {
    const R = 6371000;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const x = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // src/background/NavigationController.ts
  class NavigationController {
    session;
    ui;
    location;
    compass;
    display;
    navigation;
    storage;
    places;
    unsubs = [];
    started = false;
    logSeq = 0;
    lastHudKey = "";
    coords = null;
    heading = null;
    mapsReady = false;
    trip = {
      status: "idle",
      running: false,
      maneuver: null,
      activeDestination: null,
      activeDestinationName: null,
      routePoints: null,
      offRouteAt: null
    };
    activePivot = null;
    upcomingPivot = null;
    log = [];
    devSettings = {
      simulate: false,
      speedMultiplier: 5,
      wrongSidewalk: false,
      skipCrossings: false
    };
    constructor(session) {
      this.session = session;
      this.ui = session.ui;
      this.location = new LocationManager(session);
      this.compass = new CompassManager(session);
      this.display = new DisplayManager2(session);
      this.navigation = new NavigationManager(session);
      this.storage = new SimpleStorageManager(session);
      this.places = new PlacesManager;
    }
    start() {
      if (this.started)
        return;
      this.started = true;
      this.wireSensorSubscriptions();
      this.wireRpcHandlers();
      this.wireUIBroadcasts();
      this.wireHUDPump();
      this.primeNavigationPermission();
      this.seedInitialFix();
      this.session.onBeforeDisconnect(() => this.dispose());
    }
    wireSensorSubscriptions() {
      this.unsubs.push(this.location.onUpdate((d) => {
        this.coords = {
          lat: d.lat,
          lng: d.lng,
          accuracy: d.accuracy,
          ts: d.timestamp ?? Date.now()
        };
        this.ui.send("nav:coords", this.coords);
        this.refreshHUD();
      }));
      const HEADING_MIN_INTERVAL_MS = 100;
      let lastHeadingAt = 0;
      let pendingHeading = null;
      let pendingTimer = null;
      const flushHeading = () => {
        pendingTimer = null;
        if (pendingHeading == null)
          return;
        this.heading = pendingHeading;
        pendingHeading = null;
        lastHeadingAt = Date.now();
        this.ui.send("nav:heading", { degrees: this.heading });
      };
      this.unsubs.push(this.compass.onUpdate((d) => {
        const now = Date.now();
        const elapsed = now - lastHeadingAt;
        if (elapsed >= HEADING_MIN_INTERVAL_MS) {
          this.heading = d.degrees;
          lastHeadingAt = now;
          this.ui.send("nav:heading", { degrees: this.heading });
        } else {
          pendingHeading = d.degrees;
          if (!pendingTimer)
            pendingTimer = setTimeout(flushHeading, HEADING_MIN_INTERVAL_MS - elapsed);
        }
      }));
      this.unsubs.push(() => {
        if (pendingTimer)
          clearTimeout(pendingTimer);
        pendingTimer = null;
        pendingHeading = null;
      });
      this.unsubs.push(this.navigation.onPivot(() => {
        this.activePivot = this.navigation.getActivePivot();
        this.upcomingPivot = this.navigation.getUpcomingPivot();
        this.ui.send("nav:pivots", {
          active: this.activePivot,
          upcoming: this.upcomingPivot
        });
        this.refreshHUD();
      }));
      this.unsubs.push(this.navigation.onUpdate((u) => {
        this.appendLog(this.formatUpdate(u));
        switch (u.kind) {
          case "maneuver":
            this.trip = {
              ...this.trip,
              status: "navigating",
              running: true,
              maneuver: u,
              offRouteAt: null
            };
            break;
          case "off_route":
            this.trip = { ...this.trip, offRouteAt: Date.now() };
            break;
          case "rerouting":
            this.trip = { ...this.trip, status: "rerouting" };
            break;
          case "arrived":
            this.trip = {
              ...this.trip,
              status: "arrived",
              running: false,
              maneuver: null,
              activeDestination: null,
              routePoints: null,
              offRouteAt: null
            };
            break;
          case "error":
            this.trip = { ...this.trip, status: "idle", running: false };
            break;
        }
        this.ui.send("nav:trip-state", this.trip);
        this.refreshHUD();
      }));
      this.unsubs.push(this.navigation.onRoute((route) => {
        this.trip = { ...this.trip, routePoints: route.points };
        this.ui.send("nav:route", { points: route.points });
        this.ui.send("nav:trip-state", this.trip);
      }));
    }
    wireRpcHandlers() {
      this.unsubs.push(this.ui.handle("nav:compute-route", (opts) => this.navigation.computeRoute(opts)));
      this.unsubs.push(this.ui.handle("nav:request-permission", () => this.navigation.requestPermission()));
      this.unsubs.push(this.ui.handle("nav:get-snapshot", () => this.buildSnapshot()));
      this.unsubs.push(this.ui.handle("places:autocomplete", ({ query, near }, ctx) => this.places.autocomplete(query, near, ctx?.signal)));
      this.unsubs.push(this.ui.handle("places:details", ({ placeId }, ctx) => this.places.details(placeId, ctx?.signal)));
      this.unsubs.push(this.ui.handle("storage:list-saved", () => this.storage.getAllSavedPlaces()));
      this.unsubs.push(this.ui.handle("storage:add-saved", (p) => this.storage.addSavedPlace(p)));
      this.unsubs.push(this.ui.handle("storage:remove-saved", ({ placeId }) => this.storage.removeSavedPlace(placeId)));
      this.unsubs.push(this.ui.handle("storage:list-recent", () => this.storage.getRecentSearches()));
      this.unsubs.push(this.ui.handle("storage:add-recent", (p) => this.storage.addRecentSearch(p)));
    }
    wireUIBroadcasts() {
      this.unsubs.push(this.ui.on("nav:start", async (opts) => {
        const { destinationName, ...startOpts } = opts;
        this.trip = {
          ...this.trip,
          status: "navigating",
          running: true,
          activeDestination: startOpts.stops?.[startOpts.stops.length - 1] ?? null,
          activeDestinationName: destinationName ?? null,
          maneuver: null,
          offRouteAt: null
        };
        this.appendLog(`START ${destinationName ?? "(unnamed)"}`);
        this.ui.send("nav:trip-state", this.trip);
        try {
          await this.navigation.start(startOpts);
        } catch (err) {
          this.appendLog(`START error: ${err instanceof Error ? err.message : String(err)}`);
          this.trip = { ...this.trip, status: "idle", running: false };
          this.ui.send("nav:trip-state", this.trip);
        }
      }));
      this.unsubs.push(this.ui.on("nav:stop", () => {
        this.appendLog("STOP");
        try {
          this.navigation.stop();
        } catch {}
        this.trip = {
          ...this.trip,
          status: "idle",
          running: false,
          maneuver: null,
          activeDestination: null,
          routePoints: null,
          offRouteAt: null
        };
        this.ui.send("nav:trip-state", this.trip);
        this.refreshHUD();
      }));
      this.unsubs.push(this.ui.on("nav:deviate", () => {
        try {
          this.navigation.dev.deviate();
        } catch (err) {
          this.appendLog(`deviate failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }));
      this.unsubs.push(this.ui.on("nav:set-destination", (place) => {
        if (place)
          this.appendLog(`set-destination ${place.name}`);
      }));
      this.unsubs.push(this.ui.on("nav:set-dev-settings", (partial) => {
        const next = { ...this.devSettings, ...partial };
        try {
          if (partial.wrongSidewalk !== undefined && partial.wrongSidewalk !== this.devSettings.wrongSidewalk) {
            this.navigation.dev.setWrongSidewalkOffset(partial.wrongSidewalk);
          }
          if (partial.skipCrossings !== undefined && partial.skipCrossings !== this.devSettings.skipCrossings) {
            this.navigation.dev.setSkipCrossings(partial.skipCrossings);
          }
        } catch (err) {
          this.appendLog(`dev-settings forward failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.devSettings = next;
        this.ui.send("nav:dev-settings-update", this.devSettings);
      }));
      this.unsubs.push(this.ui.onOpen(() => this.ui.send("nav:snapshot", this.buildSnapshot())));
    }
    wireHUDPump() {
      const handle = setTimeout(() => {
        try {
          this.refreshHUD();
        } catch {}
      }, 250);
      this.unsubs.push(() => clearTimeout(handle));
    }
    refreshHUD() {
      const { status, running, activeDestinationName, maneuver } = this.trip;
      let next = null;
      let durationMs;
      if (status === "arrived") {
        const at = activeDestinationName ? ` at ${activeDestinationName}` : "";
        next = `You have arrived${at}`;
        durationMs = 1e4;
      } else if (!running) {
        next = `Welcome to Mentra Navigation!
Pick a destination to get started.`;
        durationMs = 5000;
      } else if (status === "rerouting") {
        next = "Rebuilding route…";
      } else if (this.activePivot) {
        const verb = this.activePivot.direction === "right" ? "Turn right" : "Turn left";
        const namedRoad = isRealRoadName(this.activePivot.toRoad);
        const onto = namedRoad ? `onto ${namedRoad}` : null;
        next = [verb, onto].filter(Boolean).join(`
`);
      } else if (this.upcomingPivot && this.coords) {
        const dist = haversineMeters2({ lat: this.coords.lat, lng: this.coords.lng }, { lat: this.upcomingPivot.lat, lng: this.upcomingPivot.lng });
        const isCross = this.upcomingPivot.maneuver === "CROSS_STREET";
        const verb = isCross ? "Cross the road" : this.upcomingPivot.direction === "right" ? "Turn right" : "Turn left";
        const distStr = formatDistance(dist);
        const nextRoad = isCross ? null : isRealRoadName(this.upcomingPivot.fromRoad);
        const topLine = nextRoad ? `Onto ${nextRoad}` : null;
        next = [topLine, `${verb} in ${distStr}`].filter(Boolean).join(`
`);
      } else if (maneuver?.distanceToDestinationMeters != null && maneuver.distanceToDestinationMeters >= 0) {
        next = `Arriving in ${formatDistance(maneuver.distanceToDestinationMeters)}`;
      } else if (running) {
        next = "Arriving";
      }
      if (next == null)
        return;
      const key = `${next} ${durationMs ?? 0}`;
      if (key === this.lastHudKey)
        return;
      this.lastHudKey = key;
      this.display.showText(next, durationMs);
    }
    primeNavigationPermission() {
      this.session.waitForReady().then(() => this.navigation.requestPermission()).then((r) => this.appendLog(`requestPermission: ${JSON.stringify(r)}`)).catch((err) => {
        console.warn("[NavigationController] requestPermission failed", err);
      });
    }
    seedInitialFix() {
      this.location.getOnce().then((d) => {
        if (this.coords)
          return;
        this.coords = { lat: d.lat, lng: d.lng, accuracy: d.accuracy, ts: d.timestamp ?? Date.now() };
        this.ui.send("nav:coords", this.coords);
      }).catch(() => {});
    }
    appendLog(line) {
      const entry = { id: ++this.logSeq, ts: Date.now(), line };
      this.log = [entry, ...this.log].slice(0, 100);
      this.ui.send("nav:log-append", entry);
    }
    formatUpdate(u) {
      switch (u.kind) {
        case "maneuver":
          return `MANEUVER ${u.maneuverType} dist=${u.distanceMeters.toFixed(0)}m`;
        case "off_route":
          return `OFF_ROUTE ${Math.round(u.offRouteDistanceMeters)}m off`;
        case "rerouting":
          return "REROUTING";
        case "arrived":
          return "ARRIVED";
        case "error":
          return `ERROR ${u.message}`;
        default:
          return `UPDATE ${u.kind ?? "?"}`;
      }
    }
    buildSnapshot() {
      return {
        coords: this.coords,
        heading: this.heading,
        mapsReady: this.mapsReady,
        trip: this.trip,
        activePivot: this.activePivot,
        upcomingPivot: this.upcomingPivot,
        log: [...this.log],
        devSettings: this.devSettings
      };
    }
    dispose() {
      try {
        this.navigation.stop();
      } catch {}
      try {
        this.display.clear();
      } catch {}
      for (const u of this.unsubs) {
        try {
          u();
        } catch {}
      }
      this.unsubs = [];
    }
  }
  function isRealRoadName(s) {
    if (!s)
      return null;
    if (/^Pivot \d+$/i.test(s))
      return null;
    return s;
  }

  // src/background/index.ts
  registerMiniapp((session) => {
    new NavigationController(session).start();
  });
})();
