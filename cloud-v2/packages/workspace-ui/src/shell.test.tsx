import { describe, expect, test } from "bun:test";
import { CodeXml, CreditCard, KeyRound, Settings, Users } from "lucide-react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge } from "./components/common";
import { AccountFooter, AppShell, type NavGroup, type NavItem } from "./shell/app-shell";
import { BrandPage, MentraLogo } from "./shell/brand";
import { CenteredLayout } from "./shell/centered-layout";
import type { ShellLinkProps } from "./shell/link";
import { SWITCHER_ITEM_CLASS, WorkspaceSwitcher, type SwitcherWorkspace } from "./shell/workspace-switcher";
import { Textarea } from "./ui/textarea";

// Synthetic data only. Everything is a server render: no router, no network.

/** A host's router link, marked so a test can tell it from a plain anchor. */
function HostLink(props: ShellLinkProps) {
  return <a data-host-link="" {...props} />;
}

const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]+)"/g)].map(match => match[1]!);
/** The class of the `<div>` whose whole text is `text`. */
const divClass = (markup: string, text: string) => new RegExp(`<div class="([^"]*)">${text}</div>`).exec(markup)?.[1];

const SECTIONS: NavGroup[] = [
  {
    key: "workspace",
    items: [
      { key: "members", label: "Members", icon: Users, href: "/w/ws_acme/members" },
      { key: "settings", label: "Settings", icon: Settings, href: "/w/ws_acme/settings" },
    ],
  },
  { key: "fleet", label: "Fleet", items: [] },
];

function shell(props: Partial<Parameters<typeof AppShell>[0]> = {}, children: ReactNode = <p>Page</p>): string {
  return renderToStaticMarkup(
    <AppShell
      brandTitle="Mentra Portal"
      brandSubtitle="MentraOS"
      nav={SECTIONS}
      active={item => item.key === "members"}
      userEmail="sam@acme.test"
      {...props}
    >
      {children}
    </AppShell>,
  );
}

describe("the shell's brand", () => {
  test("names the site beside the mark, with the platform under it", () => {
    const markup = shell();
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg><div class="min-w-0"><div[^>]*>Mentra Portal<\/div><div[^>]*>MentraOS<\/div>/);
  });

  test("takes any site's name, and leaves the second line out without a subtitle", () => {
    const markup = shell({ brandTitle: "Developer Console", brandSubtitle: undefined });
    expect(markup).toMatch(/<div class="min-w-0"><div[^>]*>Developer Console<\/div><\/div>/);
    expect(markup).not.toContain("Mentra Portal");
    expect(markup).not.toContain("MentraOS");
  });

  test("is drawn in the tokens' colours, not fixed hex values", () => {
    const markup = shell();
    expect(markup).not.toMatch(/\[#[0-9a-f]{3,8}\]/i);
    expect(divClass(markup, "Mentra Portal")).toContain("text-foreground");
    expect(divClass(markup, "MentraOS")).toContain("text-muted-foreground");
  });
});

describe("the shell's navigation", () => {
  test("an href item renders through the host's link component, and the active matcher marks the page", () => {
    const markup = shell({ linkComponent: HostLink });
    expect(markup).toMatch(/<a data-host-link="" href="\/w\/ws_acme\/members" aria-current="page"[^>]*>.*?Members<\/a>/);
    expect(markup).toMatch(/<a data-host-link="" href="\/w\/ws_acme\/settings" class="[^"]*">.*?Settings<\/a>/);
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
  });

  test("without a link component an href item is a plain anchor", () => {
    const markup = shell();
    expect(markup).not.toContain("data-host-link");
    expect(markup).toMatch(/<a href="\/w\/ws_acme\/members" aria-current="page"/);
  });

  test("without an active matcher nothing is marked current", () => {
    expect(shell({ active: undefined })).not.toContain("aria-current");
  });

  test("an onSelect item is a button that navigates, marked current by the same matcher", () => {
    const nav: NavGroup[] = [
      {
        key: "admin",
        label: "Moderation",
        items: [
          { key: "queue", label: "Review queue", icon: KeyRound, onSelect: () => {} },
          { key: "history", label: "History", icon: Settings, onSelect: () => {} },
        ],
      },
    ];
    const markup = shell({ nav, active: item => item.key === "queue", linkComponent: HostLink });
    expect(markup).toMatch(/<button type="button" data-navigates="" aria-current="page" class="[^"]*w-full[^"]*">.*?Review queue<\/button>/);
    expect(markup).toMatch(/<button type="button" data-navigates="" class="[^"]*">.*?History<\/button>/);
    expect(markup).toContain(">Moderation<");
    expect(hrefs(markup)).toEqual([]);
  });

  test("a group with no items renders nothing, its label included", () => {
    expect(shell()).not.toContain(">Fleet<");
  });

  test("links to other sites open a new tab as plain anchors, never through the host's link", () => {
    const links = [{ key: "console", label: "Developer Console", icon: CodeXml, href: "https://console.example.test" }];
    const markup = shell({ links, linkComponent: HostLink });
    expect(markup).toMatch(/<a href="https:\/\/console\.example\.test" target="_blank" rel="noreferrer"[^>]*>.*?Developer Console.*?\(opens in a new tab\)<\/span><\/a>/);
    expect(markup.indexOf("/w/ws_acme/settings")).toBeLessThan(markup.indexOf("console.example.test"));
    expect(markup.indexOf("console.example.test")).toBeLessThan(markup.indexOf("Open account menu"));
  });

  test("the switcher sits under the brand; without one there is no slot", () => {
    const withSwitcher = shell({ switcher: <div id="switcher-slot" /> });
    expect(withSwitcher.indexOf("MentraOS")).toBeLessThan(withSwitcher.indexOf('id="switcher-slot"'));
    expect(withSwitcher.indexOf('id="switcher-slot"')).toBeLessThan(withSwitcher.indexOf("<nav"));
    expect(shell()).not.toContain('class="shrink-0 px-3"');
  });

  test("a title makes the sticky header; without one there is only the mobile menu bar", () => {
    const titled = shell({ title: "Members", description: "Who has access", headerAction: <button type="button">Invite</button> });
    expect(titled).toMatch(/<header class="[^"]*sticky top-0[^"]*">/);
    expect(titled).toMatch(/<h1[^>]*>Members<\/h1><p[^>]*>Who has access<\/p>/);
    expect(titled).toContain(">Invite</button>");
    const untitled = shell();
    expect(untitled).not.toContain("<header");
    expect(untitled).toContain('aria-label="Open sidebar"');
    expect(untitled).toContain("<p>Page</p>");
  });

  test("names the navigation for assistive technology", () => {
    expect(shell()).toContain('<nav aria-label="Workspace"');
    expect(shell({ navLabel: "Account" })).toContain('<nav aria-label="Account"');
  });
});

describe("the account menu", () => {
  const menu = (items: NavItem[], props: Partial<Parameters<typeof AccountFooter>[0]> = {}) =>
    renderToStaticMarkup(<AccountFooter userEmail="sam@acme.test" items={items} defaultOpen {...props} />);

  test("offers the host's items above Sign out, links through the host's link component", () => {
    const markup = menu([{ key: "billing", label: "Billing", icon: CreditCard, href: "/account/billing" }], { linkComponent: HostLink });
    expect(markup).toMatch(/<a data-host-link="" href="\/account\/billing"[^>]*>.*?Billing<\/a>/);
    expect(markup.indexOf("Billing")).toBeLessThan(markup.indexOf("Sign out"));
  });

  test("an onSelect item is a button", () => {
    const markup = menu([{ key: "profile", label: "Profile", icon: Users, onSelect: () => {} }]);
    expect(markup).toMatch(/<button type="button" class="[^"]*cursor-pointer[^"]*">.*?Profile<\/button>/);
    expect(hrefs(markup)).toEqual([]);
  });

  test("always offers Sign out, disabled while signing out", () => {
    expect(menu([])).toContain(">Sign out</button>");
    expect(menu([], { signingOut: true })).toMatch(/<button type="button" class="[^"]*" disabled="">.*?Signing out\.\.\.<\/button>/);
  });

  test("closed, it shows only who is signed in", () => {
    const markup = renderToStaticMarkup(<AccountFooter userEmail="sam@acme.test" />);
    expect(markup).toContain("sam@acme.test");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Sign out");
  });

  test("is part of the shell, with the shell's items", () => {
    const markup = renderToStaticMarkup(
      <AppShell brandTitle="Mentra Portal" nav={[]} userEmail="sam@acme.test" accountItems={[]}>
        {null}
      </AppShell>,
    );
    expect(markup).toContain('aria-label="Open account menu"');
  });
});

describe("the workspace switcher", () => {
  const workspaces: SwitcherWorkspace[] = [
    { workspaceId: "ws_acme", name: "Acme Field Team", roleLabel: "Owner", href: "/w/ws_acme/members" },
    { workspaceId: "ws_northwind", name: "Northwind Pilot", roleLabel: "Developer", href: "/w/ws_northwind/members" },
  ];
  const open = (props: Partial<Parameters<typeof WorkspaceSwitcher>[0]> = {}) =>
    renderToStaticMarkup(
      <WorkspaceSwitcher
        current={workspaces[0]!}
        workspaces={workspaces}
        invitations={[]}
        canCreate
        createNotice={null}
        onCreate={() => {}}
        defaultOpen
        {...props}
      />,
    );

  test("lists your workspaces with the current one checked, then Create workspace", () => {
    const markup = open();
    expect(markup).toContain('role="menu"');
    expect(markup).toContain("Northwind Pilot");
    expect(markup).toContain('href="/w/ws_northwind/members"');
    expect(markup).toContain('aria-label="Current workspace"');
    expect(markup).toContain("Create workspace");
    expect(markup).not.toContain("Pending invitations");
    expect(markup.indexOf("Northwind Pilot")).toBeLessThan(markup.indexOf("Create workspace"));
  });

  test("a workspace with an href is a link through the host's link component", () => {
    const markup = open({ linkComponent: HostLink });
    expect(markup).toMatch(/<a data-host-link="" href="\/w\/ws_acme\/members" role="menuitem" aria-current="true"/);
    expect(markup).toMatch(/<a data-host-link="" href="\/w\/ws_northwind\/members" role="menuitem" class=/);
  });

  test("a workspace with onSelect is a menu button that navigates, the current one marked", () => {
    const selectable: SwitcherWorkspace[] = workspaces.map(({ href: _href, ...workspace }) => ({ ...workspace, onSelect: () => {} }));
    const markup = open({ workspaces: selectable, linkComponent: HostLink });
    expect(hrefs(markup)).toEqual([]);
    expect(markup).toMatch(/<button type="button" role="menuitem" data-navigates="" aria-current="true" class="[^"]*">.*?Acme Field Team/);
    expect(markup).toMatch(/<button type="button" role="menuitem" data-navigates="" class="[^"]*">.*?Northwind Pilot/);
  });

  test("the host's extra items sit under the workspaces and above Create workspace", () => {
    const markup = open({
      extraItems: (
        <a role="menuitem" href="https://portal.example.test/w/ws_acme" className={SWITCHER_ITEM_CLASS}>
          Manage workspace
        </a>
      ),
    });
    expect(markup.indexOf("Northwind Pilot")).toBeLessThan(markup.indexOf("Manage workspace"));
    expect(markup.indexOf('role="separator"')).toBeLessThan(markup.indexOf("Manage workspace"));
    expect(markup.indexOf("Manage workspace")).toBeLessThan(markup.indexOf("Create workspace"));
  });

  test("pending invitations come last, with a count and the host's actions", () => {
    const markup = open({
      invitations: [{ key: "winv_1", label: "Join Contoso", detail: "Member · from olivia@acme.test", actions: <button type="button" role="menuitem">Accept</button> }],
    });
    expect(markup).toContain("Pending invitations");
    expect(markup).toContain("Join Contoso");
    expect(markup).toContain("Member · from olivia@acme.test");
    expect(markup).toContain(">Accept</button>");
    expect(markup).toContain("(1 pending invitation)");
    expect(markup).toContain("ring-background absolute");
    expect(markup.indexOf("Create workspace")).toBeLessThan(markup.indexOf("Pending invitations"));
  });

  test("no invitations, no badge and no section", () => {
    const markup = open({ invitations: [] });
    expect(markup).not.toContain("Pending invitations");
    expect(markup).not.toContain("pending invitation");
    expect(markup).not.toContain("ring-background absolute");
  });

  test("says why creating is not offered", () => {
    const markup = open({ canCreate: false, createNotice: "Workspaces here are created by its administrators." });
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("created by its administrators");
  });

  test("while the list loads, the menu says so", () => {
    const markup = open({ workspaces: undefined });
    expect(markup).toContain("Loading…");
    expect(markup).not.toContain("Retry");
  });

  test("when the list cannot be loaded, the menu says so and offers a retry instead of loading forever", () => {
    const markup = open({ workspaces: undefined, listFailed: true, onRetry: () => {} });
    expect(markup).toContain("load your workspaces");
    expect(markup).toContain("Retry");
    expect(markup).not.toContain("Loading…");
    expect(markup).toContain("Create workspace");
  });

  test("closed, it shows only the current workspace and your role", () => {
    const markup = open({ defaultOpen: false });
    expect(markup).toContain("Acme Field Team");
    expect(markup).toContain("Owner");
    expect(markup).not.toContain('role="menu"');
  });

  test("with no current workspace it asks you to choose one, and counts yours", () => {
    const markup = open({ current: null, defaultOpen: false });
    expect(markup).toContain('aria-label="Choose a workspace"');
    expect(markup).toContain("2 workspaces");
  });
});

describe("the brand pieces and the centered layout", () => {
  test("the logo is one image named Mentra; a brand page shows it over its title", () => {
    expect(renderToStaticMarkup(<MentraLogo />)).toMatch(/^<svg[^>]*role="img" aria-label="Mentra"/);
    const page = renderToStaticMarkup(<BrandPage title="Signed out">Come back soon.</BrandPage>);
    expect(page).toMatch(/aria-label="Mentra".*<h1[^>]*>Signed out<\/h1>Come back soon\./);
  });

  test("the centered layout shows the logo, who is signed in and Sign out, over one column", () => {
    const markup = renderToStaticMarkup(
      <CenteredLayout userEmail="sam@acme.test" onSignOut={() => {}}>
        <p>First run</p>
      </CenteredLayout>,
    );
    expect(markup).toContain('aria-label="Mentra"');
    expect(markup).toContain("sam@acme.test");
    expect(markup).toContain("Sign out");
    expect(markup).toMatch(/<main[^>]*><p>First run<\/p><\/main>/);
    const signingOut = renderToStaticMarkup(
      <CenteredLayout userEmail="sam@acme.test" signingOut>
        {null}
      </CenteredLayout>,
    );
    expect(signingOut).toMatch(/disabled="".*Signing out\.\.\./);
  });
});

describe("badges and the textarea", () => {
  test("a badge is outlined by default, as before tones existed", () => {
    expect(renderToStaticMarkup(<Badge>You</Badge>)).toBe(
      '<span class="border-border text-muted-foreground inline-flex h-6 items-center rounded-full border px-2.5 text-xs leading-none font-semibold whitespace-nowrap">You</span>',
    );
  });

  test("the tones are filled from the tokens", () => {
    const tone = (value: "success" | "warn" | "neutral") => renderToStaticMarkup(<Badge tone={value}>x</Badge>);
    expect(tone("success")).toContain("bg-info text-info-foreground");
    expect(tone("warn")).toContain("bg-error text-error-foreground");
    expect(tone("neutral")).toContain("bg-surface text-foreground");
    for (const value of ["success", "warn", "neutral"] as const) {
      expect(tone(value)).toContain("border-transparent");
      expect(tone(value)).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
  });

  test("the textarea is drawn like the input, from the tokens", () => {
    const markup = renderToStaticMarkup(<Textarea name="notes" placeholder="What changed" aria-invalid />);
    expect(markup).toMatch(/^<textarea data-slot="textarea" class="[^"]*"/);
    for (const token of ["border-border", "bg-surface", "text-foreground", "placeholder:text-muted-foreground", "aria-invalid:border-destructive", "text-base"]) {
      expect(markup).toContain(token);
    }
    expect(markup).toContain('name="notes"');
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}/i);
  });
});
