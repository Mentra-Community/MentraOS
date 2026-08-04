// @generated MentraJS polyfill bundle — see mobile/modules/jspolyfill
"use strict";
(() => {
  // src/startup.ts
  (function installMentraJSRuntime() {
    const g = globalThis;
    function installConsole() {
      const safeStringify = (args) => {
        try {
          return JSON.stringify(
            args.map((a) => {
              if (a instanceof Error) {
                return { __error: true, name: a.name, message: a.message, stack: a.stack };
              }
              return a;
            })
          );
        } catch {
          return JSON.stringify(args.map((a) => String(a)));
        }
      };
      const make = (level, prev) => {
        return (...args) => {
          try {
            __hostLog(level, safeStringify(args));
          } catch {
          }
          if (prev) {
            try {
              prev(...args);
            } catch {
            }
          }
        };
      };
      const prevConsole = g.console;
      const c = {
        log: make("log", prevConsole?.log?.bind(prevConsole)),
        info: make("info", prevConsole?.info?.bind(prevConsole)),
        warn: make("warn", prevConsole?.warn?.bind(prevConsole)),
        error: make("error", prevConsole?.error?.bind(prevConsole)),
        debug: make("debug", prevConsole?.debug?.bind(prevConsole)),
        trace: make("trace", prevConsole?.trace?.bind(prevConsole))
      };
      g.console = c;
    }
    installConsole();
    g.onerror = (msg, src, line, col, err) => {
      try {
        __hostError(
          JSON.stringify({
            message: String(msg),
            src: src ?? "",
            line: line ?? 0,
            col: col ?? 0,
            stack: err && err.stack ? err.stack : ""
          })
        );
      } catch {
      }
      return false;
    };
    try {
      const origThen = g.Promise.prototype.then;
      const seen = /* @__PURE__ */ new WeakSet();
      g.Promise.prototype.then = function patchedThen(onFulfilled, onRejected) {
        seen.add(this);
        return origThen.call(this, onFulfilled, onRejected);
      };
      g.__reportUnhandledRejection = (reason) => {
        try {
          __hostUnhandledRejection(
            JSON.stringify({
              reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason
            })
          );
        } catch {
        }
      };
    } catch {
    }
    function installTimers() {
      const callbacks = /* @__PURE__ */ new Map();
      let nextToken = 1;
      g.__deliverTimer = (token) => {
        const entry = callbacks.get(token);
        if (!entry) return;
        try {
          entry.fn();
        } catch (e) {
          try {
            __hostError(
              JSON.stringify({
                message: e instanceof Error ? e.message : String(e),
                stack: e instanceof Error ? e.stack : void 0,
                source: "timer",
                token
              })
            );
          } catch {
          }
        }
        if (entry.repeating) {
          try {
            __nativeSetTimeout(token, entry.interval);
          } catch {
            callbacks.delete(token);
          }
        } else {
          callbacks.delete(token);
        }
      };
      const installSetTimeout = g.setTimeout == null || g.__mentraOwnsSetTimeout;
      if (installSetTimeout) {
        g.setTimeout = (fn, delayMs, ...rest) => {
          const token = nextToken++;
          const ms = typeof delayMs === "number" ? Math.max(0, delayMs) : 0;
          callbacks.set(token, {
            fn: () => fn(...rest),
            repeating: false,
            interval: ms
          });
          try {
            __nativeSetTimeout(token, ms);
          } catch {
            callbacks.delete(token);
            return -1;
          }
          return token;
        };
        g.clearTimeout = (token) => {
          if (typeof token !== "number") return;
          callbacks.delete(token);
          try {
            __nativeClearTimer(token);
          } catch {
          }
        };
        g.__mentraOwnsSetTimeout = true;
      }
      g.setInterval = (fn, delayMs, ...rest) => {
        const token = nextToken++;
        const ms = typeof delayMs === "number" ? Math.max(0, delayMs) : 0;
        callbacks.set(token, {
          fn: () => fn(...rest),
          repeating: true,
          interval: ms
        });
        try {
          __nativeSetTimeout(token, ms);
        } catch {
          callbacks.delete(token);
          return -1;
        }
        return token;
      };
      g.clearInterval = (token) => {
        if (typeof token !== "number") return;
        callbacks.delete(token);
        try {
          __nativeClearTimer(token);
        } catch {
        }
      };
      if (typeof g.queueMicrotask !== "function") {
        g.queueMicrotask = (cb) => {
          g.Promise.resolve().then(() => {
            try {
              cb();
            } catch (e) {
              try {
                __hostError(
                  JSON.stringify({
                    message: e instanceof Error ? e.message : String(e),
                    stack: e instanceof Error ? e.stack : void 0,
                    source: "queueMicrotask"
                  })
                );
              } catch {
              }
            }
          });
        };
      }
    }
    installTimers();
    function installAbortController() {
      if (typeof g.AbortController === "function") return;
      class MentraAbortSignal {
        constructor() {
          this.aborted = false;
          this.reason = void 0;
          this.listeners = /* @__PURE__ */ new Set();
        }
        addEventListener(type, cb) {
          if (type !== "abort" || typeof cb !== "function") return;
          if (this.aborted) {
            try {
              cb();
            } catch {
            }
            return;
          }
          this.listeners.add(cb);
        }
        removeEventListener(type, cb) {
          if (type !== "abort") return;
          this.listeners.delete(cb);
        }
        /** @internal — only invoked by the owning AbortController.abort(). */
        __fire(reason) {
          if (this.aborted) return;
          this.aborted = true;
          this.reason = reason;
          for (const cb of this.listeners) {
            try {
              cb();
            } catch {
            }
          }
          this.listeners.clear();
        }
      }
      class MentraAbortController {
        constructor() {
          this.signal = new MentraAbortSignal();
        }
        abort(reason) {
          this.signal.__fire(reason ?? new Error("aborted"));
        }
      }
      ;
      MentraAbortSignal.any = (signals) => {
        const out = new MentraAbortSignal();
        const onAbort = (s) => {
          if (!out.aborted) out.__fire(s.reason);
        };
        for (const s of signals) {
          if (s.aborted) {
            onAbort(s);
            break;
          }
          s.addEventListener("abort", () => onAbort(s));
        }
        return out;
      };
      g.AbortController = MentraAbortController;
      g.AbortSignal = MentraAbortSignal;
    }
    installAbortController();
    const pending = /* @__PURE__ */ new Map();
    let nextReqId = 1;
    g.__deliver = (envelopeJson) => {
      let env;
      try {
        env = JSON.parse(envelopeJson);
      } catch {
        try {
          __hostError(JSON.stringify({ message: "Bad __deliver envelope JSON", source: "__deliver" }));
        } catch {
        }
        return;
      }
      if (env.kind === "response" && env.reqId) {
        const handlers = pending.get(env.reqId);
        if (handlers) {
          pending.delete(env.reqId);
          if (env.ok) {
            handlers.resolve(env.result);
          } else {
            handlers.reject(env.error ?? { code: "NATIVE_THROW", message: "Unknown native error" });
          }
        }
        return;
      }
      if (env.kind === "event" && typeof env.iface === "string") {
        const listeners = g.__mentraEventListeners ?? /* @__PURE__ */ new Map();
        const set = listeners.get(env.iface);
        if (set) {
          for (const l of set) {
            try {
              l(env.payload);
            } catch (e) {
              try {
                __hostError(
                  JSON.stringify({
                    message: e instanceof Error ? e.message : String(e),
                    stack: e instanceof Error ? e.stack : void 0,
                    source: `event:${env.iface}`
                  })
                );
              } catch {
              }
            }
          }
        }
        return;
      }
      if (env.kind === "ws-event") {
        const wsHook = g.__mentraDeliverWebSocketEvent;
        const sid = env.sid;
        const wsType = env.wsType;
        if (typeof wsHook === "function" && typeof sid === "string" && typeof wsType === "string") {
          wsHook(sid, wsType, env.payload ?? {});
        }
        return;
      }
      if (env.kind === "bridge" && typeof env.raw === "string") {
        const deliver = g.__mentraDeliverBridgeRaw;
        if (typeof deliver === "function") {
          deliver(env.raw);
        }
        return;
      }
      if (env.kind === "init" && typeof env.sessionId === "string") {
        ;
        g.__mentraSessionId = env.sessionId;
        const initCb = g.__mentraInitCallback;
        if (initCb) initCb(env.sessionId);
      }
    };
    g.__mentraSendOneShot = (iface, method, args) => {
      try {
        __dispatch(iface, method, JSON.stringify(args ?? []));
      } catch (e) {
        try {
          __hostError(
            JSON.stringify({
              message: e instanceof Error ? e.message : String(e),
              source: `oneShot:${iface}.${method}`
            })
          );
        } catch {
        }
      }
    };
    g.__mentraSendRequest = (iface, method, args) => {
      return new g.Promise((resolve, reject) => {
        const reqId = `${nextReqId++}`;
        pending.set(reqId, { resolve, reject });
        try {
          __dispatch(iface, method, JSON.stringify({ args: args ?? [], reqId }));
        } catch (e) {
          pending.delete(reqId);
          reject({ code: "NATIVE_THROW", message: e instanceof Error ? e.message : String(e) });
        }
      });
    };
    g.__mentraEventListeners = /* @__PURE__ */ new Map();
    g.__mentraSubscribe = (iface, cb) => {
      const map = g.__mentraEventListeners;
      let set = map.get(iface);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        map.set(iface, set);
      }
      set.add(cb);
      return () => {
        set.delete(cb);
      };
    };
    const dispatchSyncOrNull = (iface, method, args) => {
      try {
        const raw = __dispatch(iface, method, JSON.stringify(args ?? []));
        if (raw == null) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      } catch {
        return null;
      }
    };
    g.__mentraDispatchSync = dispatchSyncOrNull;
    const localStorage = {
      getItem(key) {
        const v = dispatchSyncOrNull("localStorage", "getItem", [String(key)]);
        return typeof v === "string" ? v : null;
      },
      setItem(key, value) {
        dispatchSyncOrNull("localStorage", "setItem", [String(key), String(value)]);
      },
      removeItem(key) {
        dispatchSyncOrNull("localStorage", "removeItem", [String(key)]);
      },
      clear() {
        dispatchSyncOrNull("localStorage", "clear", []);
      },
      key(index) {
        const v = dispatchSyncOrNull("localStorage", "key", [Number(index)]);
        return typeof v === "string" ? v : null;
      },
      get length() {
        const v = dispatchSyncOrNull("localStorage", "length", []);
        return typeof v === "number" ? v : 0;
      }
    };
    g.localStorage = localStorage;
    const cryptoNs = g.crypto ?? {};
    if (typeof cryptoNs.getRandomValues !== "function") {
      cryptoNs.getRandomValues = (arr) => {
        const bytes = dispatchSyncOrNull("crypto", "getRandomBytes", [arr.byteLength]);
        if (!Array.isArray(bytes) || bytes.length !== arr.byteLength) {
          const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
          for (let i = 0; i < view.length; i++) view[i] = Math.floor(Math.random() * 256);
        } else {
          const view = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
          for (let i = 0; i < bytes.length; i++) view[i] = bytes[i] & 255;
        }
        return arr;
      };
    }
    if (typeof cryptoNs.randomUUID !== "function") {
      cryptoNs.randomUUID = () => {
        const buf = new Uint8Array(16);
        cryptoNs.getRandomValues(buf);
        buf[6] = buf[6] & 15 | 64;
        buf[8] = buf[8] & 63 | 128;
        const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      };
    }
    if (!cryptoNs.subtle) {
      const notImplemented = () => {
        throw new Error(
          "crypto.subtle is not yet implemented in MentraJS \u2014 see agents/mentrajs-two-layer-miniapp-architecture.md (Polyfill strategy section). Use a pure-JS hash/encrypt library for now."
        );
      };
      cryptoNs.subtle = new Proxy(
        {},
        {
          get: () => notImplemented
        }
      );
    }
    ;
    g.crypto = cryptoNs;
    if (typeof g.TextEncoder !== "function") {
      class TextEncoderPolyfill {
        constructor() {
          this.encoding = "utf-8";
        }
        encode(input) {
          const str = input ?? "";
          const out = [];
          for (let i = 0; i < str.length; i++) {
            let code = str.charCodeAt(i);
            if (code >= 55296 && code <= 56319 && i + 1 < str.length) {
              const next = str.charCodeAt(i + 1);
              if (next >= 56320 && next <= 57343) {
                code = (code - 55296 << 10) + (next - 56320) + 65536;
                i++;
              }
            }
            if (code < 128) {
              out.push(code);
            } else if (code < 2048) {
              out.push(192 | code >> 6, 128 | code & 63);
            } else if (code < 65536) {
              out.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
            } else {
              out.push(
                240 | code >> 18,
                128 | code >> 12 & 63,
                128 | code >> 6 & 63,
                128 | code & 63
              );
            }
          }
          return new Uint8Array(out);
        }
      }
      ;
      g.TextEncoder = TextEncoderPolyfill;
    }
    if (typeof g.TextDecoder !== "function") {
      class TextDecoderPolyfill {
        constructor(encoding = "utf-8") {
          this.encoding = encoding;
        }
        decode(buffer) {
          if (!buffer) return "";
          const bytes = buffer instanceof Uint8Array ? buffer : buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          let out = "";
          let i = 0;
          while (i < bytes.length) {
            const b1 = bytes[i++];
            let code;
            if (b1 < 128) {
              code = b1;
            } else if (b1 < 192) {
              code = 65533;
            } else if (b1 < 224) {
              code = (b1 & 31) << 6 | bytes[i++] & 63;
            } else if (b1 < 240) {
              code = (b1 & 15) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63;
            } else {
              code = (b1 & 7) << 18 | (bytes[i++] & 63) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63;
            }
            if (code > 65535) {
              code -= 65536;
              out += String.fromCharCode(55296 + (code >> 10), 56320 + (code & 1023));
            } else {
              out += String.fromCharCode(code);
            }
          }
          return out;
        }
      }
      ;
      g.TextDecoder = TextDecoderPolyfill;
    }
    if (typeof g.btoa !== "function") {
      const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      g.btoa = (input) => {
        let out = "";
        let i = 0;
        while (i < input.length) {
          const c1 = input.charCodeAt(i++);
          const c2 = i < input.length ? input.charCodeAt(i++) : NaN;
          const c3 = i < input.length ? input.charCodeAt(i++) : NaN;
          const e1 = c1 >> 2;
          const e2 = (c1 & 3) << 4 | (Number.isNaN(c2) ? 0 : c2 >> 4);
          const e3 = Number.isNaN(c2) ? 64 : (c2 & 15) << 2 | (Number.isNaN(c3) ? 0 : c3 >> 6);
          const e4 = Number.isNaN(c3) ? 64 : c3 & 63;
          out += b64[e1] + b64[e2] + (e3 === 64 ? "=" : b64[e3]) + (e4 === 64 ? "=" : b64[e4]);
        }
        return out;
      };
      g.atob = (input) => {
        const clean = input.replace(/=+$/, "");
        let out = "";
        let buf = 0;
        let bits = 0;
        for (let i = 0; i < clean.length; i++) {
          const idx = b64.indexOf(clean[i]);
          if (idx < 0) continue;
          buf = buf << 6 | idx;
          bits += 6;
          if (bits >= 8) {
            bits -= 8;
            out += String.fromCharCode(buf >> bits & 255);
          }
        }
        return out;
      };
    }
    if (typeof g.fetch !== "function") {
      ;
      g.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        let bodyString = null;
        const reqBody = init?.body;
        if (typeof reqBody === "string") {
          bodyString = reqBody;
        } else if (reqBody && typeof reqBody.toString === "function") {
          bodyString = reqBody.toString();
        }
        const headers = {};
        const rawHeaders = init?.headers;
        if (rawHeaders) {
          if (Array.isArray(rawHeaders)) {
            for (const [k, v] of rawHeaders) {
              if (k != null) headers[String(k)] = String(v);
            }
          } else if (typeof rawHeaders.forEach === "function") {
            ;
            rawHeaders.forEach((v, k) => {
              headers[k] = v;
            });
          } else {
            for (const [k, v] of Object.entries(rawHeaders)) {
              headers[String(k)] = String(v);
            }
          }
        }
        const sendRequest = g.__mentraSendRequest;
        const result = await sendRequest("fetch", "request", [
          { url, method, headers, body: bodyString }
        ]);
        const bodyText = typeof result.body === "string" ? result.body : "";
        const responseHeaders = new Map(Object.entries(result.headers ?? {}));
        class ResponseLike {
          constructor() {
            this.status = result.status;
            this.statusText = result.statusText ?? "";
            this.ok = result.ok ?? (result.status >= 200 && result.status < 300);
            this.url = url;
            this.headers = {
              get: (k) => responseHeaders.get(k.toLowerCase()) ?? null,
              has: (k) => responseHeaders.has(k.toLowerCase()),
              forEach: (cb) => {
                for (const [k, v] of responseHeaders) cb(v, k);
              }
            };
          }
          async text() {
            return bodyText;
          }
          async json() {
            try {
              return JSON.parse(bodyText);
            } catch (e) {
              const err = new Error(
                `Failed to parse JSON response from ${url}: ${e instanceof Error ? e.message : String(e)}`
              );
              err.name = "SyntaxError";
              throw err;
            }
          }
          async arrayBuffer() {
            const enc = new g.TextEncoder();
            return enc.encode(bodyText).buffer;
          }
        }
        return new ResponseLike();
      };
    }
    if (typeof g.WebSocket !== "function") {
      let bytesToBase642 = function(bytes) {
        const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let out = "";
        let i = 0;
        while (i < bytes.length) {
          const c1 = bytes[i++];
          const c2 = i < bytes.length ? bytes[i++] : NaN;
          const c3 = i < bytes.length ? bytes[i++] : NaN;
          const e1 = c1 >> 2;
          const e2 = (c1 & 3) << 4 | (Number.isNaN(c2) ? 0 : c2 >> 4);
          const e3 = Number.isNaN(c2) ? 64 : (c2 & 15) << 2 | (Number.isNaN(c3) ? 0 : c3 >> 6);
          const e4 = Number.isNaN(c3) ? 64 : c3 & 63;
          out += b64[e1] + b64[e2] + (e3 === 64 ? "=" : b64[e3]) + (e4 === 64 ? "=" : b64[e4]);
        }
        return out;
      }, base64ToBytes2 = function(s) {
        const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        const clean = s.replace(/=+$/, "");
        const out = [];
        let buf = 0;
        let bits = 0;
        for (let i = 0; i < clean.length; i++) {
          const idx = b64.indexOf(clean[i]);
          if (idx < 0) continue;
          buf = buf << 6 | idx;
          bits += 6;
          if (bits >= 8) {
            bits -= 8;
            out.push(buf >> bits & 255);
          }
        }
        return new Uint8Array(out);
      }, queueMicrotaskSafe2 = function(fn) {
        const q = g.queueMicrotask;
        if (typeof q === "function") q(fn);
        else g.Promise.resolve().then(fn);
      };
      var bytesToBase64 = bytesToBase642, base64ToBytes = base64ToBytes2, queueMicrotaskSafe = queueMicrotaskSafe2;
      const sockets = /* @__PURE__ */ new Map();
      g.__mentraDeliverWebSocketEvent = (sid, type, payload) => {
        const sock = sockets.get(sid);
        if (!sock) return;
        sock._deliver(type, payload ?? {});
      };
      class MentraWebSocket {
        constructor(url, protocols) {
          this.CONNECTING = 0;
          this.OPEN = 1;
          this.CLOSING = 2;
          this.CLOSED = 3;
          this.readyState = 0;
          this.bufferedAmount = 0;
          this.extensions = "";
          this.protocol = "";
          this.binaryType = "arraybuffer";
          this.onopen = null;
          this.onmessage = null;
          this.onerror = null;
          this.onclose = null;
          this.listeners = {
            open: /* @__PURE__ */ new Set(),
            message: /* @__PURE__ */ new Set(),
            error: /* @__PURE__ */ new Set(),
            close: /* @__PURE__ */ new Set()
          };
          this.url = String(url);
          const protoList = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
          this.sid = `ws-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
          sockets.set(this.sid, this);
          try {
            __dispatch(
              "ws",
              "open",
              JSON.stringify([{ sid: this.sid, url: this.url, protocols: protoList }])
            );
          } catch (e) {
            this.readyState = 3;
            queueMicrotaskSafe2(() => this._deliver("error", { message: String(e) }));
            queueMicrotaskSafe2(() => this._deliver("close", { code: 1006, reason: "bridge unavailable" }));
          }
        }
        addEventListener(type, cb) {
          if (!this.listeners[type]) this.listeners[type] = /* @__PURE__ */ new Set();
          this.listeners[type].add(cb);
        }
        removeEventListener(type, cb) {
          this.listeners[type]?.delete(cb);
        }
        send(data) {
          if (this.readyState === 3) {
            throw new Error("WebSocket is already in CLOSING or CLOSED state.");
          }
          let kind;
          let payload;
          if (typeof data === "string") {
            kind = "text";
            payload = data;
          } else {
            kind = "binary";
            const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            payload = bytesToBase642(bytes);
          }
          try {
            __dispatch("ws", "send", JSON.stringify([{ sid: this.sid, kind, payload }]));
          } catch (e) {
            this._deliver("error", { message: String(e) });
          }
        }
        close(code, reason) {
          if (this.readyState === 2 || this.readyState === 3) return;
          this.readyState = 2;
          try {
            __dispatch(
              "ws",
              "close",
              JSON.stringify([{ sid: this.sid, code: code ?? 1e3, reason: reason ?? "" }])
            );
          } catch (e) {
            this.readyState = 3;
            this._deliver("close", { code: 1006, reason: String(e) });
          }
        }
        /** @internal — called by __deliver via the global hook. */
        _deliver(type, ev) {
          if (type === "open") {
            this.readyState = 1;
            if (typeof ev.protocol === "string") this.protocol = ev.protocol;
          } else if (type === "close") {
            this.readyState = 3;
            sockets.delete(this.sid);
          }
          const synth = { type, target: this, ...ev };
          if (type === "message" && ev.kind === "binary" && typeof ev.data === "string") {
            synth.data = base64ToBytes2(ev.data).buffer;
          } else if (type === "message" && ev.kind === "text") {
            synth.data = ev.data;
          }
          const propMap = {
            open: "onopen",
            message: "onmessage",
            error: "onerror",
            close: "onclose"
          };
          const prop = propMap[type];
          const handler = this[prop];
          if (handler) {
            try {
              handler(synth);
            } catch (e) {
              try {
                __hostError(
                  JSON.stringify({
                    message: e instanceof Error ? e.message : String(e),
                    source: `WebSocket.${prop}`
                  })
                );
              } catch {
              }
            }
          }
          const set = this.listeners[type];
          if (set) {
            for (const cb of set) {
              try {
                cb(synth);
              } catch (e) {
                try {
                  __hostError(
                    JSON.stringify({
                      message: e instanceof Error ? e.message : String(e),
                      source: `WebSocket.addEventListener("${type}")`
                    })
                  );
                } catch {
                }
              }
            }
          }
        }
      }
      MentraWebSocket.CONNECTING = 0;
      MentraWebSocket.OPEN = 1;
      MentraWebSocket.CLOSING = 2;
      MentraWebSocket.CLOSED = 3;
      ;
      g.WebSocket = MentraWebSocket;
    }
    try {
      __dispatch("__runtime", "ready", JSON.stringify([]));
    } catch {
    }
  })();
})();
