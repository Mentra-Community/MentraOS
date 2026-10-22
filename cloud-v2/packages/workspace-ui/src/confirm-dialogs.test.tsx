/**
 * Leave workspace, Delete workspace, Revoke invitation and Revoke key ask in a dialog, not in place of the button: the
 * dialog opens with the question, Cancel sends nothing and gives focus back, and the destructive button sends the request.
 * Driven through the real panels against a recording fake of Core.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CredentialView, InvitationView, WorkspaceRole } from "@mentra/workspace-contract";
import type { ReactElement } from "react";
import { createWorkspaceApi, type FetchLike, type WorkspaceApi } from "./api";
import { WorkspaceCredentialsPanel } from "./components/credentials-panel";
import { WorkspacePendingInvitationsPanel } from "./components/invitations-panel";
import { WorkspaceSettingsPanel } from "./components/settings-panel";
import { byText, cleanup, click, find, findAll, render, setupDom, teardownDom, typeInto, until } from "./test-dom";
import { CREDENTIALS, detailFor, INVITATIONS, membersFor, seedClient, WORKSPACE_ID, WORKSPACE_NAME } from "./test-fixtures";

beforeAll(setupDom);
afterAll(teardownDom);
afterEach(cleanup);

const BASE = "/api/workspaces";
const WS = `/${WORKSPACE_ID}`;

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Core's side of the lists the dialogs act on, and a way to make it refuse. */
interface World {
  invitations: InvitationView[];
  credentials: CredentialView[];
  refuse?: (call: Call) => Response | undefined;
}

const reply = (status: number, body?: unknown) =>
  ({ ok: status >= 200 && status < 300, status, statusText: "", json: async () => structuredClone(body) }) as unknown as Response;

const TWO_KEYS: CredentialView[] = [CREDENTIALS[0]!, { ...CREDENTIALS[0]!, credentialId: "cred_docs", name: "Docs bot" }];

function serve(detail: unknown, members: unknown, world: World, calls: Call[]): FetchLike {
  return async (input, init) => {
    const path = String(input).slice(BASE.length);
    const method = init?.method ?? "GET";
    const call: Call = { method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const refused = world.refuse?.(call);
    if (refused) return refused;
    if (method === "GET" && path === WS) return reply(200, detail);
    if (method === "GET" && path === `${WS}/members`) return reply(200, { items: members });
    if (method === "GET" && path === `${WS}/invitations`) return reply(200, { items: world.invitations });
    if (method === "GET" && path === `${WS}/credentials`) return reply(200, { items: world.credentials });
    const invitation = new RegExp(`^${WS}/invitations/([^/]+)$`).exec(path);
    if (method === "DELETE" && invitation) {
      world.invitations = world.invitations.filter((other) => other.invitationId !== invitation[1]);
      return reply(204);
    }
    const credential = new RegExp(`^${WS}/credentials/([^/]+)$`).exec(path);
    if (method === "DELETE" && credential) {
      world.credentials = world.credentials.filter((other) => other.credentialId !== credential[1]);
      return reply(204);
    }
    if ((method === "POST" && path === `${WS}/leave`) || (method === "DELETE" && path === WS)) return reply(204);
    return reply(404, { error: "not_found" });
  };
}

async function mount(role: WorkspaceRole, panel: (api: WorkspaceApi) => ReactElement) {
  const detail = detailFor(role);
  const members = membersFor(detail);
  const world: World = { invitations: structuredClone(INVITATIONS), credentials: structuredClone(TWO_KEYS) };
  const calls: Call[] = [];
  const api = createWorkspaceApi({ basePath: BASE, fetch: serve(detail, members, world, calls) });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } } });
  seedClient(api, structuredClone({ detail, members, invitations: world.invitations, credentials: world.credentials }), client);
  await render(<QueryClientProvider client={client}>{panel(api)}</QueryClientProvider>);
  return { world, writes: () => calls.filter((call) => call.method !== "GET") };
}

const openDialogs = () => findAll<HTMLDialogElement>("dialog").filter((dialog) => dialog.open);
const theDialog = () => {
  const [dialog, ...others] = openDialogs();
  if (!dialog || others.length > 0) throw new Error(`expected one open dialog, found ${openDialogs().length}`);
  return dialog;
};
const buttonsIn = (dialog: HTMLElement) =>
  findAll("button", dialog).map((button) => button.getAttribute("aria-label") ?? button.textContent!.trim());
const trigger = (label: string) => find<HTMLButtonElement>(`button[aria-label="${label}"]`);
const inDialog = (text: string) => byText<HTMLButtonElement>(text, "button", theDialog());

describe("Leave workspace", () => {
  const settings = () => {
    const left = mock(() => {});
    const mounted = mount("owner", (api) => <WorkspaceSettingsPanel api={api} workspaceId={WORKSPACE_ID} onLeft={left} />);
    return { left, mounted };
  };

  test("asks in a dialog, Cancel sends nothing and gives focus back, Leave sends the request", async () => {
    const { left, mounted } = settings();
    const { writes } = await mounted;
    const button = trigger("Leave workspace");
    // The old inline prompt is gone: nothing replaces the button.
    expect(findAll('[role="group"]')).toHaveLength(0);
    await click(button);
    const dialog = theDialog();
    expect(find("h2", dialog).textContent).toBe(`Leave ${WORKSPACE_NAME}?`);
    expect(dialog.textContent).toContain("You lose access to this workspace.");
    expect(buttonsIn(dialog)).toEqual(["Close", "Cancel", "Leave"]);
    expect(inDialog("Leave").className).toContain("bg-destructive");
    expect(writes()).toHaveLength(0);

    await click(inDialog("Cancel"));
    expect(openDialogs()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
    expect(document.activeElement).toBe(button);

    await click(button);
    await click(inDialog("Leave"));
    await until(() => left.mock.calls.length === 1, "Leave to go through");
    expect(writes()).toEqual([{ method: "POST", path: `${WS}/leave`, body: undefined }]);
  });

  test("a refusal is shown in the dialog, which stays open, with focus back on the Leave button", async () => {
    const { mounted } = settings();
    const { world, writes } = await mounted;
    world.refuse = (call) => (call.method === "POST" ? reply(403, { error: "forbidden" }) : undefined);
    await click(trigger("Leave workspace"));
    await click(inDialog("Leave"));
    await until(() => findAll('[role="alert"]', theDialog()).length === 1, "the refusal");
    expect(find('[role="alert"]', theDialog()).textContent).toBe("You do not have permission to do that.");
    expect(inDialog("Leave").hasAttribute("disabled")).toBe(false);
    // The button was disabled while the request was out, which dropped focus; it is back on the button for another try.
    expect(document.activeElement).toBe(inDialog("Leave"));
    expect(writes()).toHaveLength(1);
  });
});

describe("Delete workspace", () => {
  test("asks in a dialog that wants the workspace's name typed back, Cancel sends nothing, Delete sends the request", async () => {
    const deleted = mock(() => {});
    const { writes } = await mount("owner", (api) => <WorkspaceSettingsPanel api={api} workspaceId={WORKSPACE_ID} onDeleted={deleted} />);
    const button = byText<HTMLButtonElement>("Delete workspace", "button");
    await click(button);
    const dialog = theDialog();
    expect(find("h2", dialog).textContent).toBe(`Delete ${WORKSPACE_NAME}?`);
    expect(dialog.textContent).toContain("Deleting a workspace ends every membership and invitation and revokes every key. It cannot be undone.");
    expect(buttonsIn(dialog)).toEqual(["Close", "Cancel", "Delete"]);
    expect(inDialog("Delete").className).toContain("bg-destructive");

    // The name is typed here, in the dialog, and Delete waits for all of it.
    const field = find<HTMLInputElement>("input", dialog);
    expect(find("label", dialog).textContent).toBe(`Type ${WORKSPACE_NAME} to confirm`);
    expect(find("label", dialog).getAttribute("for")).toBe(field.id);
    expect(document.activeElement).toBe(field);
    expect(inDialog("Delete").hasAttribute("disabled")).toBe(true);
    await typeInto(field, "Acme");
    expect(inDialog("Delete").hasAttribute("disabled")).toBe(true);

    await click(inDialog("Cancel"));
    expect(openDialogs()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
    expect(document.activeElement).toBe(button);

    // Asked again, the field starts empty.
    await click(button);
    expect(find<HTMLInputElement>("input", theDialog()).value).toBe("");
    await typeInto(find<HTMLInputElement>("input", theDialog()), WORKSPACE_NAME);
    expect(inDialog("Delete").hasAttribute("disabled")).toBe(false);
    await click(inDialog("Delete"));
    await until(() => deleted.mock.calls.length === 1, "Delete to go through");
    expect(writes()).toEqual([{ method: "DELETE", path: WS, body: { confirmName: WORKSPACE_NAME } }]);
  });

  test("a refusal because a service holds the workspace is shown in the dialog, in words", async () => {
    const { world } = await mount("owner", (api) => <WorkspaceSettingsPanel api={api} workspaceId={WORKSPACE_ID} />);
    const holds = [{ service: "store", reason: "owns_miniapps", count: 1 }];
    world.refuse = (call) =>
      call.method === "DELETE" ? reply(409, { error: "workspace_has_holds", error_description: "workspace_has_holds", holds }) : undefined;
    await click(byText("Delete workspace", "button"));
    await typeInto(find<HTMLInputElement>("input", theDialog()), WORKSPACE_NAME);
    await click(inDialog("Delete"));
    await until(() => findAll('[role="alert"]', theDialog()).length === 1, "the refusal");
    expect(find('[role="alert"]', theDialog()).textContent).toBe("This workspace still owns 1 miniapp. Delete it in the Developer Console first.");
    expect(document.activeElement).toBe(inDialog("Delete"));
  });
});

describe("Revoke invitation", () => {
  const pending = () => mount("owner", (api) => <WorkspacePendingInvitationsPanel api={api} workspaceId={WORKSPACE_ID} />);
  const NEWBIE = "Revoke invitation for newbie@acme.test";
  const BOSS = "Revoke invitation for boss@acme.test";

  test("asks in a dialog, Cancel sends nothing and gives focus back, Revoke sends the request and focus moves on", async () => {
    const { writes } = await pending();
    expect(findAll('[role="group"]')).toHaveLength(0);
    await click(trigger(NEWBIE));
    const dialog = theDialog();
    expect(find("h2", dialog).textContent).toBe("Revoke the invitation for newbie@acme.test?");
    expect(dialog.textContent).toContain("The link they were sent stops working.");
    expect(buttonsIn(dialog)).toEqual(["Close", "Cancel", "Revoke"]);
    expect(inDialog("Revoke").className).toContain("bg-destructive");
    expect(writes()).toHaveLength(0);

    await click(inDialog("Cancel"));
    expect(openDialogs()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger(NEWBIE));

    await click(trigger(NEWBIE));
    await click(inDialog("Revoke"));
    await until(() => openDialogs().length === 0 && findAll(`button[aria-label="${NEWBIE}"]`).length === 0, "the invitation to go");
    expect(writes()).toEqual([{ method: "DELETE", path: `${WS}/invitations/inv_member`, body: undefined }]);
    // Its row is gone, so focus is on the next row's button.
    expect(document.activeElement).toBe(trigger(BOSS));
  });

  test("a refusal is shown in the dialog, which stays open", async () => {
    const { world } = await pending();
    world.refuse = (call) => (call.method === "DELETE" ? reply(403, { error: "forbidden" }) : undefined);
    await click(trigger(NEWBIE));
    await click(inDialog("Revoke"));
    await until(() => findAll('[role="alert"]', theDialog()).length === 1, "the refusal");
    expect(find('[role="alert"]', theDialog()).textContent).toBe("You do not have permission to do that.");
    expect(document.activeElement).toBe(inDialog("Revoke"));
  });
});

describe("Revoke key", () => {
  const keys = () => mount("developer", (api) => <WorkspaceCredentialsPanel api={api} workspaceId={WORKSPACE_ID} />);

  test("asks in a dialog, Cancel sends nothing and gives focus back, Revoke sends the request and focus moves on", async () => {
    const { writes } = await keys();
    expect(findAll('[role="group"]')).toHaveLength(0);
    await click(trigger("Revoke CI publisher"));
    const dialog = theDialog();
    expect(find("h2", dialog).textContent).toBe("Revoke CI publisher?");
    expect(dialog.textContent).toContain("Anything using it stops working.");
    expect(buttonsIn(dialog)).toEqual(["Close", "Cancel", "Revoke"]);
    expect(writes()).toHaveLength(0);

    await click(inDialog("Cancel"));
    expect(openDialogs()).toHaveLength(0);
    expect(writes()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger("Revoke CI publisher"));

    await click(trigger("Revoke CI publisher"));
    await click(inDialog("Revoke"));
    await until(() => openDialogs().length === 0 && findAll('button[aria-label="Revoke CI publisher"]').length === 0, "the key to go");
    expect(writes()).toEqual([{ method: "DELETE", path: `${WS}/credentials/cred_ci`, body: undefined }]);
    expect(document.activeElement).toBe(trigger("Revoke Docs bot"));
  });
});
