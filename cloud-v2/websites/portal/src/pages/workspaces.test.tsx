import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { capabilitiesForRole, type WorkspaceDetail, type WorkspaceRole } from "@mentra/workspace-contract";
import { workspaceKeys } from "@mentra/workspace-ui";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginGate } from "../App";
import { creationNotice, portalWorkspaceApi, visibleTabs, WorkspacesPage } from "./workspaces";

const detail = (role: WorkspaceRole): Pick<WorkspaceDetail, "capabilities"> => ({
  capabilities: [...capabilitiesForRole(role)],
});

describe("the workspace tabs follow the viewer's role", () => {
  test("members and developers get settings only; admins add members, invitations and the audit log", () => {
    expect(visibleTabs(detail("member"))).toEqual(["settings"]);
    expect(visibleTabs(detail("developer"))).toEqual(["settings"]);
    expect(visibleTabs(detail("admin"))).toEqual(["members", "invitations", "settings", "audit"]);
    expect(visibleTabs(detail("owner"))).toEqual(["members", "invitations", "settings", "audit"]);
    expect(visibleTabs(undefined)).toEqual(["settings"]);
  });
});

describe("creating a workspace", () => {
  test("says why creation is not offered", () => {
    expect(creationNotice({ allowed: true, reason: null })).toBeNull();
    expect(creationNotice({ allowed: false, reason: "email_unverified" })).toContain("Verify");
    expect(creationNotice({ allowed: false, reason: "organization_admins_only" })).toContain("administrators");
  });

  function render(allowed: boolean, inviteToken: string | null = null) {
    const client = new QueryClient();
    client.setQueryData(workspaceKeys.list(portalWorkspaceApi), []);
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <WorkspacesPage
          creation={allowed ? { allowed: true, reason: null } : { allowed: false, reason: "email_unverified" }}
          inviteToken={inviteToken}
          onInviteDone={() => {}}
        />
      </QueryClientProvider>,
    );
  }

  test("offers New workspace only when this person may create one", () => {
    expect(render(true)).toContain("New workspace");
    const refused = render(false);
    expect(refused).not.toContain("New workspace");
    expect(refused).toContain("Verify your account");
  });

  test("an invitation link shows the accept screen and never renders its token", () => {
    const html = render(true, "secret-invite-token");
    expect(html).toContain("Invitation");
    expect(html).toContain("Dismiss invitation");
    expect(html).not.toContain("secret-invite-token");
  });
});

test("the login gate says to sign in with the invited address when an invitation is pending", () => {
  const loginUrl = "/api/portal/auth/login?return_to=%2F";
  expect(renderToStaticMarkup(<LoginGate invitePending loginUrl={loginUrl} />)).toContain("your invitation was sent to");
  expect(renderToStaticMarkup(<LoginGate loginUrl={loginUrl} />)).not.toContain("your invitation was sent to");
});
