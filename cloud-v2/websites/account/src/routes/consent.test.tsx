import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { decideConsent, startConsent } from "../lib/consent-flow";
import { CONTINUATION, createFakeInteractions } from "../test-support/fake-auth";
import { ConsentView } from "./consent";

describe("the consent route (third-party clients only)", () => {
  test("shows the client and what it asks for, with Allow and Deny", () => {
    const html = renderToStaticMarkup(
      <ConsentView consent={{ clientName: "Example Notes", scopes: ["openid", "email"] }} busy={false} onDecision={() => undefined} />,
    );
    expect(html).toContain("Allow Example Notes to use your Mentra account?");
    expect(html).toContain("See your email address");
    expect(html).toContain("Allow");
    expect(html).toContain("Deny");
  });

  test("loads the interaction's details and follows the provider's continuation after a decision", async () => {
    const api = createFakeInteractions({ details: { kind: "ok", prompt: "consent", clientName: "Example Notes", scopes: ["openid"] } });
    const navigate = mock((_url: string) => undefined);
    const state = await startConsent({ api, navigate }, "?interaction=uid-1234567890");
    expect(state).toEqual({ kind: "consent", interactionId: "uid-1234567890", consent: { clientName: "Example Notes", scopes: ["openid"] } });
    expect(await decideConsent({ api, navigate }, "uid-1234567890", "deny")).toEqual({ kind: "redirecting" });
    expect(api.decide.mock.calls).toEqual([["uid-1234567890", "deny"]]);
    expect(navigate.mock.calls).toEqual([[CONTINUATION]]);
  });

  test("an interaction that is not waiting for consent is an error", async () => {
    const api = createFakeInteractions();
    expect(await startConsent({ api, navigate: () => undefined }, "?interaction=uid-1234567890")).toEqual({ kind: "error" });
  });
});
