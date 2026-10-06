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
import { useId, useReducer, useState, type FormEvent } from "react";
import type { CreateCredentialInput, WorkspaceApi } from "../api";
import { formatDate, formatDateTime } from "../lib/format";
import { credentialsQuery, useWorkspaceMutation, workspaceDetailQuery } from "../queries";
import { can } from "../roles";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ConfirmButton, CopyButton, ErrorNotice, Loading, LoadError, Panel, Restricted } from "./common";

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
  return <CredentialsPanel key={props.workspaceId} {...props} />;
}

function CredentialsPanel({ api, workspaceId }: { api: WorkspaceApi; workspaceId: string }) {
  const detailResult = useQuery(workspaceDetailQuery(api, workspaceId));
  const canUse = can(detailResult.data, "miniapps.credentials.create");
  const listResult = useQuery({ ...credentialsQuery(api, workspaceId), enabled: canUse });
  const [secret, dispatch] = useReducer(secretReducer, { status: "hidden" });

  const create = useWorkspaceMutation(api, workspaceId, (input: CreateCredentialInput) =>
    createCredentialAndReveal(api, workspaceId, input, (revealed) => dispatch({ type: "created", ...revealed })),
  );
  const revoke = useWorkspaceMutation(api, workspaceId, (credentialId: string) =>
    api.revokeCredential(workspaceId, credentialId),
  );

  if (detailResult.isPending) {
    return (
      <Panel title={TITLE} description={DESCRIPTION}>
        <Loading />
      </Panel>
    );
  }
  if (detailResult.isError) {
    return (
      <Panel title={TITLE} description={DESCRIPTION}>
        <LoadError error={detailResult.error} onRetry={() => void detailResult.refetch()} />
      </Panel>
    );
  }
  if (!canUse) {
    return (
      <Panel title={TITLE} description={DESCRIPTION}>
        <Restricted>Credentials are available to developers, admins and owners.</Restricted>
      </Panel>
    );
  }
  if (listResult.isPending) {
    return (
      <Panel title={TITLE} description={DESCRIPTION}>
        <Loading />
      </Panel>
    );
  }
  if (listResult.isError) {
    return (
      <Panel title={TITLE} description={DESCRIPTION}>
        <LoadError error={listResult.error} onRetry={() => void listResult.refetch()} />
      </Panel>
    );
  }

  return (
    <CredentialsPanelView
      credentials={listResult.data}
      secret={secret}
      busy={create.isPending || revoke.isPending}
      error={create.error ?? revoke.error}
      onCreate={(input, onCreated) => {
        revoke.reset();
        create.mutate(input, { onSuccess: onCreated });
      }}
      onRevoke={(credentialId) => {
        create.reset();
        revoke.mutate(credentialId);
      }}
      onDismissSecret={() => dispatch({ type: "dismissed" })}
    />
  );
}

export interface CredentialsPanelViewProps {
  credentials: CredentialView[];
  secret: SecretState;
  busy: boolean;
  error: unknown;
  /** `onCreated` runs when the server accepted the credential, so the form can clear itself. */
  onCreate(input: CreateCredentialInput, onCreated: () => void): void;
  onRevoke(credentialId: string): void;
  onDismissSecret(): void;
}

/**
 * The credentials screen without its data fetching. Revoke is offered on every credential the viewer can
 * see: the server allows a credential's creator or an admin and says so when it refuses, and the listing
 * does not say who the viewer is, so a developer revoking their own key must not be hidden from them.
 */
export function CredentialsPanelView({
  credentials,
  secret,
  busy,
  error,
  onCreate,
  onRevoke,
  onDismissSecret,
}: CredentialsPanelViewProps) {
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
    <Panel title={TITLE} description={DESCRIPTION}>
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
      <ErrorNotice error={error} />

      {secret.status === "shown" ? (
        <SecretDialog name={secret.name} token={secret.token} onDone={onDismissSecret} />
      ) : null}
    </Panel>
  );
}

/**
 * The creation dialog. Only Done closes it: no Escape, no click outside, so the one chance to copy the
 * token cannot be lost by accident.
 */
export function SecretDialog({ name, token, onDone }: { name: string; token: string; onDone: () => void }) {
  const titleId = useId();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
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
          <CopyButton text={token} label="Copy credential" autoFocus />
          <Button type="button" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
