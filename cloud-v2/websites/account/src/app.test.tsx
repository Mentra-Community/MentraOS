import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createApp, type AppEnvironment } from "./app";
import { createAccountConfig } from "./lib/config";
import { MESSAGES } from "./lib/messages";
import { createFakeAuth, createFakeInteractions } from "./test-support/fake-auth";

function environment(pathname: string, search = ""): AppEnvironment & { createAuth: ReturnType<typeof mock> } {
  return {
    location: { origin: "https://account.example", pathname, search },
    navigate: () => undefined,
    createAuth: mock(() => createFakeAuth()),
    interactions: createFakeInteractions(),
  };
}

const INTERACTION = "?interaction=uid-1234567890";

describe("app", () => {
  test("without Supabase configuration the sign-in routes say so, never echo the query, and create no client", () => {
    const configs = [
      createAccountConfig({}),
      createAccountConfig({ supabaseUrl: "https://auth.example" }),
      createAccountConfig({ supabaseAnonKey: "sb_publishable_x" }),
      createAccountConfig({ supabaseUrl: "not a url", supabaseAnonKey: "sb_publishable_x" }),
    ];
    for (const config of configs) {
      for (const pathname of ["/login", "/signup"]) {
        const env = environment(pathname, `${INTERACTION}&redirect_url=https://evil.example`);
        const html = renderToStaticMarkup(createApp(config, env));
        expect(html).toContain(MESSAGES.notConfigured);
        expect(html).not.toContain("evil.example");
        expect(env.createAuth).not.toHaveBeenCalled();
      }
    }
  });

  test("an email link's outcome shows at the root without a Supabase client", () => {
    for (const config of [
      createAccountConfig({}),
      createAccountConfig({ supabaseUrl: "https://auth.example", supabaseAnonKey: "sb_publishable_x" }),
    ]) {
      const verified = { ...environment("/"), emailLink: { kind: "verified" as const } };
      const html = renderToStaticMarkup(createApp(config, verified));
      expect(html).toContain("Email verified");
      expect(verified.createAuth).not.toHaveBeenCalled();
      const failed = { ...environment("/"), emailLink: { kind: "failed" as const } };
      expect(renderToStaticMarkup(createApp(config, failed))).toContain(MESSAGES.emailLinkFailed);
    }
  });

  test("routes by pathname: login, consent, sign-up, reset, sign-out, the root, and 'Page not found'", () => {
    const config = createAccountConfig({ supabaseUrl: "https://auth.example", supabaseAnonKey: "sb_publishable_x" });
    const render = (pathname: string, search = "") => renderToStaticMarkup(createApp(config, environment(pathname, search)));

    expect(render("/somewhere-else")).toContain(MESSAGES.notFound);
    expect(render("/oauth/authorize", "?authorization_id=auth-123")).toContain(MESSAGES.notFound);
    expect(render("/login")).toContain(MESSAGES.invalidLink);
    expect(render("/login/", INTERACTION)).toContain("Checking your sign-in");
    expect(render("/consent", INTERACTION)).toContain("Loading");
    expect(render("/signup")).toContain("Create your Mentra account");
    expect(render("/reset")).toContain("Reset your password");
    expect(render("/signout")).toContain("Signing out");
    expect(render("/")).toContain("To sign in, start from the Mentra site or app you want to use.");
  });
});
