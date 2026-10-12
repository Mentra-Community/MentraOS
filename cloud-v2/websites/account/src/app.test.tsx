import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createApp, type AppEnvironment } from "./app";
import { createAccountConfig } from "./lib/config";
import { MESSAGES } from "./lib/messages";
import { createFakeAuth } from "./test-support/fake-auth";

function environment(pathname: string, search = ""): AppEnvironment & { createAuth: ReturnType<typeof mock> } {
  return {
    location: { origin: "https://account.example", pathname, search },
    navigate: () => undefined,
    storage: null,
    createAuth: mock(() => createFakeAuth()),
  };
}

const PATHS = ["/", "/oauth/authorize", "/signup", "/reset", "/signout", "/somewhere-else"];

describe("app", () => {
  test("missing Supabase configuration renders 'Sign-in is not configured.' on every route without throwing", () => {
    const configs = [
      createAccountConfig({}),
      createAccountConfig({ supabaseUrl: "https://auth.example" }),
      createAccountConfig({ supabaseAnonKey: "sb_publishable_x" }),
      createAccountConfig({ supabaseUrl: "not a url", supabaseAnonKey: "sb_publishable_x" }),
    ];
    for (const config of configs) {
      for (const pathname of PATHS) {
        const env = environment(pathname, "?authorization_id=auth-123");
        const html = renderToStaticMarkup(createApp(config, env));
        expect(html).toContain(MESSAGES.notConfigured);
        expect(html).not.toContain("auth-123");
        expect(env.createAuth).not.toHaveBeenCalled();
      }
    }
  });

  test("an email link's outcome shows at the root without a Supabase client, even when unconfigured", () => {
    for (const config of [
      createAccountConfig({}),
      createAccountConfig({ supabaseUrl: "https://auth.example", supabaseAnonKey: "sb_publishable_x" }),
    ]) {
      const verified = { ...environment("/"), emailLink: { kind: "verified" as const } };
      const html = renderToStaticMarkup(createApp(config, verified));
      expect(html).toContain("Email verified");
      expect(html).toContain(MESSAGES.emailVerified);
      expect(verified.createAuth).not.toHaveBeenCalled();

      const failed = { ...environment("/"), emailLink: { kind: "failed" as const } };
      expect(renderToStaticMarkup(createApp(config, failed))).toContain(MESSAGES.emailLinkFailed);
    }
    // Only the root shows it; other routes keep their behavior.
    const config = createAccountConfig({ supabaseUrl: "https://auth.example", supabaseAnonKey: "sb_publishable_x" });
    const signup = { ...environment("/signup"), emailLink: { kind: "verified" as const } };
    expect(renderToStaticMarkup(createApp(config, signup))).toContain("Create your Mentra account");
  });

  test("routes by pathname and shows 'Page not found' for unknown paths", () => {
    const config = createAccountConfig({ supabaseUrl: "https://auth.example", supabaseAnonKey: "sb_publishable_x" });
    const render = (pathname: string, search = "") => renderToStaticMarkup(createApp(config, environment(pathname, search)));

    expect(render("/somewhere-else")).toContain(MESSAGES.notFound);
    expect(render("/oauth/authorize")).toContain(MESSAGES.invalidLink);
    expect(render("/oauth/authorize/", "?authorization_id=auth-123")).toContain("Checking your sign-in");
    expect(render("/signup")).toContain("Create your Mentra account");
    expect(render("/signout")).toContain("Signing out");
  });
});
