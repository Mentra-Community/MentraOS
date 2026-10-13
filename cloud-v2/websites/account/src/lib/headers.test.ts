import { describe, expect, test } from "bun:test";
import { buildHeadersFile, contentSecurityPolicy, DEFAULT_SUPABASE_URL, NO_STORE_ROUTES } from "./headers";

function section(file: string, path: string): string {
  const block = file.split("\n\n").find((part) => part.startsWith(`${path}\n`));
  if (!block) throw new Error(`missing ${path} block`);
  return block;
}

describe("_headers", () => {
  test("emits the CSP with the Supabase origin, framing and referrer protection, and no-store on the sign-in routes", () => {
    const file = buildHeadersFile("http://127.0.0.1:54321/");
    const all = section(file, "/*");

    expect(all).toContain(
      "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:54321; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    expect(all).toContain("  Referrer-Policy: no-referrer");
    expect(all).toContain("  X-Content-Type-Options: nosniff");
    expect(all).not.toContain("no-store");
    for (const route of NO_STORE_ROUTES) expect(section(file, route)).toContain("  Cache-Control: no-store");
    expect(NO_STORE_ROUTES).toEqual(["/login", "/consent", "/signup", "/reset", "/signout"]);
    expect(file).not.toContain("/oauth/");

    expect(contentSecurityPolicy(undefined)).toContain(`connect-src 'self' ${DEFAULT_SUPABASE_URL};`);
    expect(contentSecurityPolicy("  ")).toContain("connect-src 'self' https://auth.mentra.glass;");
    expect(contentSecurityPolicy("https://project.supabase.co/auth/v1")).toContain(
      "connect-src 'self' https://project.supabase.co;",
    );
    expect(() => buildHeadersFile("not a url")).toThrow();
    expect(() => buildHeadersFile("javascript:alert(1)")).toThrow();
  });
});
