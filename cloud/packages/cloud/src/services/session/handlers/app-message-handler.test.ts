import { describe, expect, test } from "bun:test";
import type { Logger } from "pino";

import { AppErrorCode, sendError, streamErrorCode } from "./app-message-handler";
import type { IWebSocket } from "../../websocket/types";

function makeSocket() {
  const sent: string[] = [];
  const closed: { code?: number; reason?: string }[] = [];

  const ws: IWebSocket = {
    readyState: 1,
    send: (data) => sent.push(String(data)),
    close: (code, reason) => closed.push({ code, reason }),
  };

  return { ws, sent, closed };
}

const logger = { debug: () => {}, error: () => {} } as unknown as Logger;

const fatalCodes = Object.values(AppErrorCode).filter((code) => code !== AppErrorCode.WIFI_NOT_CONNECTED);

describe("sendError", () => {
  // A missing WiFi connection blocks one stream request, not the session.
  test("leaves the socket open for a non-fatal code", () => {
    const { ws, sent, closed } = makeSocket();

    sendError(ws, AppErrorCode.WIFI_NOT_CONNECTED, "Glasses must be on WiFi to stream", logger);

    expect(JSON.parse(sent[0]).code).toBe(AppErrorCode.WIFI_NOT_CONNECTED);
    expect(closed).toEqual([]);
  });

  test.each(fatalCodes)("closes the socket for %s", (code) => {
    const { ws, sent, closed } = makeSocket();

    sendError(ws, code, "something went wrong", logger);

    expect(JSON.parse(sent[0]).code).toBe(code);
    expect(closed).toEqual([{ code: 1008, reason: "something went wrong" }]);
  });

  test("closes with 1011 when the payload cannot be sent", () => {
    const closed: { code?: number; reason?: string }[] = [];
    const ws: IWebSocket = {
      readyState: 1,
      send: () => {
        throw new Error("socket already gone");
      },
      close: (code, reason) => closed.push({ code, reason }),
    };

    sendError(ws, AppErrorCode.WIFI_NOT_CONNECTED, "Glasses must be on WiFi to stream", logger);

    expect(closed).toEqual([{ code: 1011, reason: "Internal server error" }]);
  });
});

describe("streamErrorCode", () => {
  // Managed and unmanaged streams both tag WiFi failures this way. Reporting
  // them as INTERNAL_ERROR would close the socket, which is the bug above.
  test("classifies a tagged WiFi failure as non-fatal", () => {
    const e = Object.assign(new Error("must be connected to WiFi"), { code: "WIFI_NOT_CONNECTED" });

    expect(streamErrorCode(e)).toBe(AppErrorCode.WIFI_NOT_CONNECTED);
  });

  test("classifies the legacy no_wifi_connection message as non-fatal", () => {
    expect(streamErrorCode(new Error("no_wifi_connection"))).toBe(AppErrorCode.WIFI_NOT_CONNECTED);
  });

  test.each([new Error("rtmp handshake failed"), Object.assign(new Error("nope"), { code: "SOMETHING_ELSE" }), null])(
    "classifies everything else as INTERNAL_ERROR (%s)",
    (e) => {
      expect(streamErrorCode(e)).toBe(AppErrorCode.INTERNAL_ERROR);
    },
  );
});
