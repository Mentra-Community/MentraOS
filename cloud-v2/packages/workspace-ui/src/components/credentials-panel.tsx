/**
 * Workspace credentials: the `msk_` keys that let CI and tools publish miniapps for a workspace.
 *
 * The token exists exactly once, in the response to its creation. It goes straight into this panel's
 * `secret` state, is shown in a dialog that only the Done button closes, and is gone when it does: it
 * is never in the query cache or the mutation cache, never in a URL, and the listing shows only each
 * credential's `display` (`msk_prod_…abcd`).
 */

import { useQuery } from "@tanstack/react-query";
import type { CredentialView } from "@mentra/workspace-contract";
import { useEffect, useId, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { CreateCredentialInput, WorkspaceApi } from "../api";
import { formatDate, formatDateTime } from "../lib/format";
import { credentialsQuery, useWorkspaceMutation, workspaceDetailQuery } from "../queries";
import { can, canCreateCredentials } from "../roles";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ConfirmButton, CopyButton, ErrorNotice, Panel, QueryGate, Restricted } from "./common";

const TITLE = "Credentials";
const DESCRIPTION = "Keys that let CI and tools publish miniapps for this workspace. A key acts as the person who created it.";

// --- The one-time secret -----------------------------------------------------

export type SecretState = { status: "hidden" } | { status: "shown"; name: string; token: string };
export type SecretAction = { type: "created"; name: string; token: string } | { type: "dismissed" };

/** `hidden` holds nothing; `shown` is the only state that holds the token, and `dismissed` drops it. */
export function secretReducer(_state: SecretState, action: SecretAction): SecretState {
  return action.type === "created"
    ? { status: "shown", name: action.name, token: action.token }
    : { status: "hidden" };
}

/**
 * Creates the credential and hands its token to `reveal`, returning only the credential's listing view.
 * The token therefore never becomes the result of the mutation that calls this.
 */
export async function createCredentialAndReveal(
  api: WorkspaceApi,
  workspaceId: string,
  input: CreateCredentialInput,
  reveal: (secret: { name: string; token: string }) => void,
): Promise<CredentialView> {
  const { credential, token } = await api.createCredential(workspaceId, input);
  reveal({ name: credential.name, token });
  return credential;
}

// --- Form helpers ------------------------------------------------------------

/** Package names from a comma, space or line separated field. Undefined means "no restriction". */
export function parsePackageNames(text: string): string[] | undefined {
  const names = [...new Set(text.split(/[\s,]+/).filter(Boolean))];
  return names.length > 0 ? names : undefined;
}

/** The end of the chosen local day as an ISO 8601 string, or null for no (or an unusable) date. */
export function expiryFromDateInput(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day, 23, 59, 59);
  return date.getMonth() === month - 1 ? date.toISOString() : null;
}

/** Tomorrow as a `YYYY-MM-DD` value for the date field's `min`: an expiry must be in the future. */
function tomorrow(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// --- The panel ---------------------------------------------------------------

export function WorkspaceCredentialsPanel(props: { api: WorkspaceApi; workspaceId: string }) {
  // Keyed by workspace so a token shown for one workspace is never carried over to another.
  return <CredentialsScreen key={props.workspaceId} {...props} />;
}

/**
 * The panel itself. `initialSecret` exists so a test can render the state after a credential was created;
 * the public panel never sets it.
 *
 * The one-time dialog is rendered here, outside the loading and error states of the queries behind the
 * list: it holds the only copy of the token, so a refetch that fails must not take it off the screen.
 */
export function CredentialsScreen({
  api,
  workspaceId,
  initialSecret = { status: "hidden" },
}: {
  api: WorkspaceApi;
  workspaceId: string;
  initialSecret?: SecretState;
}) {
  const detailResult = useQuery(workspaceDetailQuery(api, workspaceId));
  const listResult = useQuery({
    ...credentialsQuery(api, workspaceId),
    enabled: can(detailResult.data, "miniapps.credentials.create"),
  });
  const [secret, dispatch] = useReducer(secretReducer, initialSecret);

  const create = useWorkspaceMutation(api, workspaceId, (input: CreateCredentialInput) =>
    createCredentialAndReveal(api, workspaceId, input, (revealed) => dispatch({ type: "created", ...revealed })),
  );
  const revoke = useWorkspaceMutation(api, workspaceId, (credentialId: string) =>
    api.revokeCredential(workspaceId, credentialId),
  );

  return (
    <>
      <Panel title={TITLE} description={DESCRIPTION}>
        <QueryGate result={detailResult}>
          {(detail) =>
            !can(detail, "miniapps.credentials.create") ? (
              <Restricted>Credentials are available to developers, admins and owners.</Restricted>
            ) : (
              <QueryGate result={listResult}>
                {(credentials) => (
                  <CredentialsContent
                    credentials={credentials}
                    canCreate={canCreateCredentials(detail)}
                    busy={create.isPending || revoke.isPending}
                    onCreate={(input, onCreated) => {
                      revoke.reset();
                      create.mutate(input, { onSuccess: onCreated });
                    }}
                    onRevoke={(credentialId) => {
                      create.reset();
                      revoke.mutate(credentialId);
                    }}
                  />
                )}
              </QueryGate>
            )
          }
        </QueryGate>
        <ErrorNotice error={create.error ?? revoke.error} />
      </Panel>
      {secret.status === "shown" ? (
        <SecretDialog name={secret.name} token={secret.token} onDone={() => dispatch({ type: "dismissed" })} />
      ) : null}
    </>
  );
}

interface CredentialsContentProps {
  credentials: CredentialView[];
  /** Whether the viewer can create a credential (see `canCreateCredentials`). */
  canCreate: boolean;
  busy: boolean;
  /** `onCreated` runs when the server accepted the credential, so the form can clear itself. */
  onCreate(input: CreateCredentialInput, onCreated: () => void): void;
  onRevoke(credentialId: string): void;
}

/**
 * The create form and the credential table. Revoke is offered on every credential the viewer can see: the
 * server allows a credential's creator or an admin and says so when it refuses, and the listing does not
 * say who the viewer is, so a developer revoking their own key must not be hidden from them.
 */
function CredentialsContent({ credentials, canCreate, busy, onCreate, onRevoke }: CredentialsContentProps) {
  const [name, setName] = useState("");
  const [packages, setPackages] = useState("");
  const [expires, setExpires] = useState("");
  const nameId = useId();
  const packagesId = useId();
  const expiresId = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const input: CreateCredentialInput = { name: trimmed };
    const packageNames = parsePackageNames(packages);
    if (packageNames) input.packageNames = packageNames;
    const expiresAt = expiryFromDateInput(expires);
    if (expiresAt) input.expiresAt = expiresAt;
    onCreate(input, () => {
      setName("");
      setPackages("");
      setExpires("");
    });
  }

  return (
    <>
      {canCreate ? (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              required
              maxLength={64}
              autoComplete="off"
              placeholder="CI publisher"
              className="w-56"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={packagesId}>Packages (optional)</Label>
            <Input
              id={packagesId}
              autoComplete="off"
              placeholder="com.example.app, com.example.other"
              className="w-72"
              value={packages}
              onChange={(event) => setPackages(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={expiresId}>Expires (optional)</Label>
            <Input
              id={expiresId}
              type="date"
              min={tomorrow()}
              className="w-44"
              value={expires}
              onChange={(event) => setExpires(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy || name.trim() === ""}>
            Create credential
          </Button>
        </form>
      ) : (
        <Restricted>
          Only members of this workspace with the developer role or above can create credentials, because a credential
          acts as the member who created it.
        </Restricted>
      )}

      {credentials.length === 0 ? (
        <Restricted>No credentials yet.</Restricted>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-muted-foreground text-xs">
              <tr>
                <th className="py-2 pr-4 font-medium">Credential</th>
                <th className="py-2 pr-4 font-medium">Packages</th>
                <th className="py-2 pr-4 font-medium">Expires</th>
                <th className="py-2 pr-4 font-medium">Last used</th>
                <th className="py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((credential) => (
                <tr key={credential.credentialId} className="border-t align-top">
                  <td className="py-2 pr-4">
                    <div className="font-medium">{credential.name}</div>
                    <code className="text-muted-foreground text-xs">{credential.display}</code>
                    <div className="text-muted-foreground text-xs">
                      {credential.issuedByService
                        ? `Issued by the ${credential.issuedByService} service`
                        : credential.createdByEmail
                          ? `Created by ${credential.createdByEmail}`
                          : null}
                    </div>
                  </td>
                  <td className="py-2 pr-4">
                    {credential.packageNames.length > 0 ? credential.packageNames.join(", ") : "All packages"}
                  </td>
                  <td className="py-2 pr-4">{credential.expiresAt ? formatDate(credential.expiresAt) : "Never"}</td>
                  <td className="py-2 pr-4">
                    {credential.lastUsedAt ? formatDateTime(credential.lastUsedAt) : "Never used"}
                  </td>
                  <td className="py-2 text-right">
                    <ConfirmButton
                      label="Revoke"
                      ariaLabel={`Revoke ${credential.name}`}
                      prompt={`Revoke ${credential.name}? Anything using it stops working.`}
                      confirmLabel="Confirm revoke"
                      disabled={busy}
                      onConfirm={() => onRevoke(credential.credentialId)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * The creation dialog. Only Done closes it: no Escape, no click outside, so the one chance to copy the
 * token cannot be lost by accident. Focus moves into it on open, stays inside it (Tab wraps between its
 * buttons), and goes back to where it was when it closes.
 */
export function SecretDialog({ name, token, onDone }: { name: string; token: string; onDone: () => void }) {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  function keepFocusInside(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const buttons = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={keepFocusInside}
        className="bg-card text-card-foreground w-full max-w-lg space-y-4 rounded-xl border p-6 shadow-lg"
      >
        <h2 id={titleId} className="text-lg leading-none font-semibold">
          Copy your new credential
        </h2>
        <p className="text-muted-foreground text-sm">
          <strong>{name}</strong> is ready. This credential is shown only once and cannot be shown again. Store it
          somewhere safe before you close this dialog.
        </p>
        <code className="bg-muted block rounded-md border p-3 text-xs break-all select-all">{token}</code>
        <div className="flex justify-end gap-2">
          <CopyButton text={token} label="Copy credential" />
          <Button type="button" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
