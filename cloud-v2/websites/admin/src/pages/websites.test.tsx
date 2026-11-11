import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EMPTY_FORM,
  parseWebsiteForm,
  SecretNotice,
  secretReducer,
  WEBSITES_QUERY_KEY,
  WebsitesPage,
  type SecretState,
  type WebsiteClient,
  type WebsiteForm,
} from "./websites";

// A synthetic secret shaped like a real one, so a leak would be recognizable.
const SECRET = "mws_SYNTHETIC0000000000000000000000000000000000";

const paperwork: WebsiteClient = {
  clientId: "mwc_01jz0synthetic0000000000a",
  name: "Paperwork",
  type: "server",
  environment: "production",
  redirectUris: ["https://paperwork.example.com/auth/callback"],
  packageName: "com.mentra.paperwork",
  ownerUserId: null,
  access: "private",
  accessWorkspaceIds: ["ws_fleet", "ws_partner"],
  status: "active",
  secretLast4: "wxyz",
  createdAt: "2026-11-11T10:00:00.000Z",
  updatedAt: "2026-11-11T10:00:00.000Z",
};
const notesDev: WebsiteClient = {
  ...paperwork,
  clientId: "mwc_01jz0synthetic0000000000b",
  name: "Notes (dev)",
  type: "browser",
  environment: "development",
  redirectUris: ["http://127.0.0.1:5173/callback"],
  packageName: "com.mentra.notes",
  ownerUserId: "mu_dev",
  access: "public",
  accessWorkspaceIds: [],
  status: "disabled",
  secretLast4: null,
};

/** `list` null leaves the list query unseeded: still loading. */
function render(list: WebsiteClient[] | null = [paperwork, notesDev]): string {
  const client = new QueryClient();
  if (list) client.setQueryData(WEBSITES_QUERY_KEY, { clients: list });
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <WebsitesPage />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

const form = (overrides: Partial<WebsiteForm> = {}): WebsiteForm => ({
  ...EMPTY_FORM,
  name: " Paperwork ",
  packageName: "com.mentra.paperwork",
  redirectUris: "https://paperwork.example.com/auth/callback\n",
  ...overrides,
});

describe("the Miniapp websites page", () => {
  test("lists each website with its client ID, miniapp, redirects, who may sign in, and its actions", () => {
    const html = render();
    expect(html).toContain("Paperwork");
    expect(html).toContain("mwc_01jz0synthetic0000000000a");
    expect(html).toContain("com.mentra.paperwork");
    expect(html).toContain("https://paperwork.example.com/auth/callback");
    expect(html).toContain("Server · secret ends wxyz");
    expect(html).toContain("Members of ws_fleet, ws_partner");
    expect(html).toContain("Registered here");
    // A developer's own, and their development one signs in only them.
    expect(html).toContain("Registered by its developer (mu_dev)");
    expect(html).toContain("Only its developer");
    expect(html).toContain('aria-label="Disable Paperwork"');
    expect(html).toContain('aria-label="Regenerate the secret of Paperwork"');
    expect(html).toContain('aria-label="Remove Paperwork"');
    // A browser site has no secret to replace; a disabled one is marked and can be enabled.
    expect(html).toContain("Browser · no secret");
    expect(html).toContain("Disabled");
    expect(html).toContain('aria-label="Enable Notes (dev)"');
    expect(html).not.toContain('aria-label="Regenerate the secret of Notes (dev)"');
  });

  test("says so while loading and when there are none", () => {
    expect(render(null)).toContain("Loading websites");
    expect(render([])).toContain("No websites are registered yet.");
  });

  test("no secret is on the page unless one was just issued", () => {
    expect(render()).not.toContain("mws_");
    expect(render()).not.toContain("Copy the client secret");
  });
});

describe("the one-time secret notice", () => {
  const notice = (secret: SecretState) => renderToStaticMarkup(<SecretNotice secret={secret} onDone={() => {}} />);

  test("shows the client ID and secret once issued, and nothing once dismissed", () => {
    const shown = secretReducer({ status: "hidden" }, { type: "issued", name: "Paperwork", clientId: paperwork.clientId, secret: SECRET });
    const html = notice(shown);
    expect(html).toContain("Copy the client secret for Paperwork");
    expect(html).toContain(paperwork.clientId);
    expect(html).toContain(SECRET);
    expect(html).toContain("only time it is shown");

    const dismissed = secretReducer(shown, { type: "dismissed" });
    expect(dismissed).toEqual({ status: "hidden" });
    expect(JSON.stringify(dismissed)).not.toContain(SECRET);
    expect(notice(dismissed)).toBe("");
  });
});

describe("the registration form", () => {
  test("a server site for production, open to anyone", () => {
    expect(parseWebsiteForm(form())).toEqual({
      ok: true,
      input: {
        name: "Paperwork",
        packageName: "com.mentra.paperwork",
        type: "server",
        environment: "production",
        redirectUris: ["https://paperwork.example.com/auth/callback"],
        access: "public",
      },
    });
  });

  test("several redirects and a private site", () => {
    const parsed = parseWebsiteForm(
      form({
        type: "browser",
        environment: "development",
        redirectUris: "http://127.0.0.1:5173/callback\nhttps://dev.example.com/cb\nhttps://dev.example.com/cb",
        access: "private",
        accessWorkspaceIds: "ws_fleet, ws_partner\nws_fleet",
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      input: {
        name: "Paperwork",
        packageName: "com.mentra.paperwork",
        type: "browser",
        environment: "development",
        redirectUris: ["http://127.0.0.1:5173/callback", "https://dev.example.com/cb"],
        access: "private",
        accessWorkspaceIds: ["ws_fleet", "ws_partner"],
      },
    });
  });

  test.each([
    ["no name", { name: "  " }, "Enter the site's name"],
    ["something that is not a package name", { packageName: "Paperwork" }, "package name"],
    ["no redirect", { redirectUris: " \n " }, "at least one redirect URI"],
    ["a redirect that is not a URL", { redirectUris: "paperwork.example.com/cb" }, "is not a URL"],
    ["an HTTP redirect", { redirectUris: "http://paperwork.example.com/cb" }, "must start with https://"],
    ["a loopback redirect on a production site", { redirectUris: "http://127.0.0.1:5173/cb" }, "only a development site"],
    ["a loopback redirect with no port", { environment: "development", redirectUris: "http://localhost/cb" }, "needs a port"],
    ["a redirect with a fragment", { redirectUris: "https://paperwork.example.com/cb#x" }, "# part"],
    ["a private site with no workspaces", { access: "private" }, "List the workspaces"],
  ] as const)("refuses %s, saying what to fix", (_label, overrides, message) => {
    const parsed = parseWebsiteForm(form(overrides));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain(message);
  });
});
