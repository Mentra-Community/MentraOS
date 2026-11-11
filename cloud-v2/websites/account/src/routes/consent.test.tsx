import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { decideConsent, shownRedirect, startConsent } from "../lib/consent-flow";
import { CONTINUATION, createFakeInteractions } from "../test-support/fake-auth";
import { ConsentView } from "./consent";

const WEBSITE = {
  clientName: "Example Notes",
  scopes: ["openid", "email", "profile"],
  returnsTo: "https://notes.example/auth/callback",
  packageName: "com.example.notes",
};

describe("the consent route (third-party clients only)", () => {
  test("shows the site, what it asks for, where it sends the person back and whose data it reaches, with Allow and Deny", () => {
    const html = renderToStaticMarkup(<ConsentView consent={WEBSITE} busy={false} onDecision={() => undefined} />);
    expect(html).toContain("Allow Example Notes to use your Mentra account?");
    expect(html).toContain("See your Mentra account ID");
    expect(html).toContain("See your email address");
    expect(html).toContain("See your name");
    expect(html).toContain("reach your data in the Example Notes miniapp");
    expect(html).toContain("Allow only if you recognise that address.");
    expect(html).toContain("https://notes.example/auth/callback");
    expect(html).toContain('href="/connections"');
    expect(html).toContain("Allow");
    expect(html).toContain("Deny");
  });

  test("a client that is not a miniapp website makes no claim about miniapp data", () => {
    const html = renderToStaticMarkup(
      <ConsentView consent={{ ...WEBSITE, packageName: null, returnsTo: null }} busy={false} onDecision={() => undefined} />,
    );
    expect(html).not.toContain("miniapp");
    expect(html).not.toContain("sent back to");
    expect(html).not.toContain("recognise that address");
  });

  test("the client's name is text, never markup", () => {
    const html = renderToStaticMarkup(
      <ConsentView consent={{ ...WEBSITE, clientName: "<img src=x onerror=alert(1)>" }} busy={false} onDecision={() => undefined} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("the address shown is the redirect's origin and path: no query, and nothing that is not a web address", () => {
    expect(shownRedirect("https://notes.example/auth/callback?next=/x")).toBe("https://notes.example/auth/callback");
    expect(shownRedirect("http://127.0.0.1:5173/callback")).toBe("http://127.0.0.1:5173/callback");
    expect(shownRedirect("https://user:pw@notes.example/cb")).toBe("https://notes.example/cb");
    expect(shownRedirect("javascript:alert(1)")).toBeNull();
    expect(shownRedirect("")).toBeNull();
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
      consent: { clientName: "Example Notes", scopes: ["openid"], returnsTo: "https://notes.example/auth/callback", packageName: "com.example.notes" },
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
