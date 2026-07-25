import { describe, expect, test } from "bun:test";
import type { Logger } from "pino";

import { AppErrorCode, sendError } from "./app-message-handler";
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
