import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { decideConsent, startConsent } from "../lib/consent-flow";
import { describeScopes } from "../lib/scopes";
import { CONTINUATION, createFakeInteractions } from "../test-support/fake-auth";
import { ConsentView } from "./consent";

const WEBSITE = {
  clientName: "Example Notes",
  scopes: ["openid", "email", "profile"],
};

describe("the consent route (third-party clients only)", () => {
  test("shows the site and one line for what it asks, with Allow and Deny, and nothing else", () => {
    const html = renderToStaticMarkup(<ConsentView consent={WEBSITE} busy={false} onDecision={() => undefined} />);
    expect(html).toContain("Allow Example Notes to use your Mentra account?");
    expect(html).toContain("Example Notes will be able to:");
    expect(html).toContain('<ul class="scopes"><li>Read basic information</li></ul>');
    expect(html).toContain("Allow");
    expect(html).toContain("Deny");
    expect(html).not.toMatch(/miniapp|sent back to|recognise|Connected apps|<a /);
  });

  test("the sign-in scopes are one line; any other scope is shown by its name", () => {
    expect(describeScopes(["openid", "email", "profile"])).toEqual(["Read basic information"]);
    expect(describeScopes(["openid"])).toEqual(["Read basic information"]);
    expect(describeScopes(["openid", "email", "offline_access"])).toEqual(["Read basic information", "offline_access"]);
    expect(describeScopes(["something_new"])).toEqual(["something_new"]);
    expect(describeScopes([])).toEqual([]);
  });

  test("the client's name is text, never markup", () => {
    const html = renderToStaticMarkup(
      <ConsentView consent={{ ...WEBSITE, clientName: "<img src=x onerror=alert(1)>" }} busy={false} onDecision={() => undefined} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("loads the interaction's details and follows the provider's continuation after a decision", async () => {
    const api = createFakeInteractions({
      details: {
        kind: "ok",
        prompt: "consent",
        clientName: "Example Notes",
        scopes: ["openid"],
        redirectUri: "https://notes.example/auth/callback?x=1",
        packageName: "com.example.notes",
      },
    });
    const navigate = mock((_url: string) => undefined);
    const state = await startConsent({ api, navigate }, "?interaction=uid-1234567890");
    expect(state).toEqual({
      kind: "consent",
      interactionId: "uid-1234567890",
      consent: { clientName: "Example Notes", scopes: ["openid"] },
    });
    expect(await decideConsent({ api, navigate }, "uid-1234567890", "deny")).toEqual({ kind: "redirecting" });
    expect(api.decide.mock.calls).toEqual([["uid-1234567890", "deny"]]);
    expect(navigate.mock.calls).toEqual([[CONTINUATION]]);
  });

  test("an interaction that is not waiting for consent is an error", async () => {
    const api = createFakeInteractions();
    expect(await startConsent({ api, navigate: () => undefined }, "?interaction=uid-1234567890")).toEqual({ kind: "error" });
  });
});
