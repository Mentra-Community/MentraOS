import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MESSAGES } from "../lib/messages";
import { createFakeAuth } from "../test-support/fake-auth";
import { LoginView } from "./login";

const auth = createFakeAuth({ session: null });
const render = (state: Parameters<typeof LoginView>[0]["state"]) =>
  renderToStaticMarkup(<LoginView state={state} auth={auth} origin="https://account.example" onSignedIn={() => undefined} />);

describe("the login route's views", () => {
  test("sign-in: email and password, Google and Apple, and sign-up and reset links that keep the sign-in", () => {
    const html = render({ kind: "sign-in", interactionId: "uid-1234567890", clientName: "Mentra admin portal", error: null });
    expect(html).toContain("Sign in to your Mentra account");
    expect(html).toContain("to continue to Mentra admin portal");
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with Apple");
    expect(html).toContain('href="/signup?interaction=uid-1234567890"');
    expect(html).toContain('href="/reset?interaction=uid-1234567890"');
  });

  test("fixed text for an invalid link, an expired sign-in, an error and a refusal", () => {
    expect(render({ kind: "invalid" })).toContain(MESSAGES.invalidLink);
    expect(render({ kind: "expired" })).toContain(MESSAGES.signInExpired);
    expect(render({ kind: "error" })).toContain(MESSAGES.authorizeFailed);
    expect(render({ kind: "sign-in", interactionId: "uid-1234567890", clientName: "", error: MESSAGES.signInRefused })).toContain(
      MESSAGES.signInRefused,
    );
  });
});
