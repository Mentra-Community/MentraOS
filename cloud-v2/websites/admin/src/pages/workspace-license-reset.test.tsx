import {describe, expect, test} from "bun:test";
import {canConfirmReset} from "./workspace-license-reset";

describe("staging reset confirmation", () => {
  test("requires the exact workspace ID, a meaningful reason and explicit acknowledgment", () => {
    expect(canConfirmReset("ws_target", "ws_target", "Restart testing", true)).toBe(true);
    for (const confirmation of ["", "ws_other", " ws_target", "ws_target "]) expect(canConfirmReset("ws_target", confirmation, "Restart testing", true)).toBe(false);
    for (const reason of ["", "    ", "test", "x".repeat(501)]) expect(canConfirmReset("ws_target", "ws_target", reason, true)).toBe(false);
    expect(canConfirmReset("ws_target", "ws_target", "Restart testing", false)).toBe(false);
  });
});
