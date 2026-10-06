import { useMutation, useQuery, useQueryClient, type QueryClient, type UseMutationOptions } from "@tanstack/react-query";
import { OPERATOR_KEY_SCOPES, type CredentialView, type OrganizationCapability } from "@mentra/workspace-contract";
import { ConfirmButton, expiryFromDateInput, SecretDialog } from "@mentra/workspace-ui";
import { Loader2, RefreshCcw } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "../lib/api";

const PANEL = "rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]";

export const OPERATOR_KEYS_QUERY_KEY = ["admin-operator-keys"] as const;

/** What each scope lets a key do, in words. */
export const SCOPE_LABELS: Record<string, string> = {
  "organization.incidents.read": "Read incident reports",
  "organization.supportProfiles.read": "Look up support profiles",
  "organization.testing.read": "View test runs",
  "organization.testing.manage": "Manage test runs",
};

/** A scope this page does not know yet shows as it is rather than disappearing. */
export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

export interface CreateOperatorKeyInput {
  name: string;
  scopes: OrganizationCapability[];
  /** An ISO 8601 date-time. Omitted for a key that never expires. */
  expiresAt?: string;
}

export type CreateKeyFormResult = { ok: true; input: CreateOperatorKeyInput } | { ok: false; message: string };

/**
 * The request for what the form holds. Scopes go out in the order of `OPERATOR_KEY_SCOPES`, once each, and
 * only those: a key never carries a scope the server would refuse. An expiry that cannot be read is refused
 * rather than dropped, since dropping it would mint a key that never expires.
 */
export function parseCreateKeyForm(form: { name: string; scopes: readonly string[]; expires: string }): CreateKeyFormResult {
  const name = form.name.trim();
  if (!name) return { ok: false, message: "Enter a name for the key." };
  const scopes = OPERATOR_KEY_SCOPES.filter(scope => form.scopes.includes(scope));
  if (scopes.length === 0) return { ok: false, message: "Choose at least one scope." };
  const input: CreateOperatorKeyInput = { name, scopes };
  if (form.expires) {
    const expiresAt = expiryFromDateInput(form.expires);
    if (!expiresAt) return { ok: false, message: "Choose a valid expiry date." };
    input.expiresAt = expiresAt;
  }
  return { ok: true, input };
}

/**
 * Creates the key and hands its token to `reveal`, returning only the key's listing view. The token
 * therefore never becomes the result of the mutation that calls this, and so is never cached.
 */
export async function createOperatorKeyAndReveal(
  input: CreateOperatorKeyInput,
  reveal: (secret: { name: string; token: string }) => void,
): Promise<CredentialView> {
  const { credential, token } = await api<{ credential: CredentialView; token: string }>("/api/organization/credentials", {
    method: "POST",
    body: input,
  });
  reveal({ name: credential.name, token });
  return credential;
}

/** `gcTime: 0` keeps the finished mutation out of the shared cache once the page lets go of it. */
export function createKeyMutationOptions(
  client: QueryClient,
  reveal: (secret: { name: string; token: string }) => void,
): UseMutationOptions<CredentialView, Error, CreateOperatorKeyInput> {
  return {
    mutationFn: input => createOperatorKeyAndReveal(input, reveal),
    gcTime: 0,
    onSettled: () => client.invalidateQueries({ queryKey: OPERATOR_KEYS_QUERY_KEY }),
  };
}

export type SecretState = { status: "hidden" } | { status: "shown"; name: string; token: string };

export function OperatorKeysPage() {
  return <OperatorKeysScreen />;
}

/**
 * The page itself. `initialSecret` exists so a test can render the state after a key was created; the
 * page never sets it.
 *
 * The one-time dialog is rendered outside the loading and error states of the list: it holds the only copy
 * of the token, so a refetch that fails must not take it off the screen. The token lives in this state
 * only, until Done: not in the query or mutation cache, not in a URL.
 */
export function OperatorKeysScreen({ initialSecret = { status: "hidden" } }: { initialSecret?: SecretState }) {
  const client = useQueryClient();
  const [secret, setSecret] = useState<SecretState>(initialSecret);
  const keys = useQuery({
    queryKey: OPERATOR_KEYS_QUERY_KEY,
    queryFn: () => api<{ items: CredentialView[] }>("/api/organization/credentials"),
  });
  const create = useMutation(createKeyMutationOptions(client, revealed => setSecret({ status: "shown", ...revealed })));
  const revoke = useMutation({
    mutationFn: (credentialId: string) =>
      api<void>(`/api/organization/credentials/${encodeURIComponent(credentialId)}`, { method: "DELETE" }),
    gcTime: 0,
    onSettled: () => client.invalidateQueries({ queryKey: OPERATOR_KEYS_QUERY_KEY }),
  });
  const busy = create.isPending || revoke.isPending;
  const items = keys.data?.items;

  return (
    <div className="space-y-6">
      <section className={PANEL}>
        <div className="border-b border-[#eceeeb] p-5">
          <h2 className="text-xl font-bold">Create an operator key</h2>
          <p className="mt-1 text-sm text-[#68746d]">
            An operator key belongs to this organization, not to a person or a workspace. It carries only the scopes you
            choose, and it cannot administer workspaces or other keys.
          </p>
        </div>
        <div className="p-5">
          <CreateKeyForm
            busy={busy}
            error={create.error}
            onCreate={(input, onCreated) => {
              revoke.reset();
              create.mutate(input, { onSuccess: onCreated });
            }}
          />
        </div>
      </section>

      <section className={PANEL}>
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#eceeeb] p-5">
          <div>
            <h2 className="text-xl font-bold">Operator keys</h2>
            <p className="mt-1 text-sm text-[#68746d]">Only the end of each key is shown. A key cannot be shown again after it is created.</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            onClick={() => keys.refetch()}
            aria-label="Refresh operator keys"
            disabled={keys.isFetching}
          >
            <RefreshCcw className={`size-4 ${keys.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
        {items === undefined && keys.isError ? (
          <div className="p-5">
            <ErrorNotice error={keys.error} />
          </div>
        ) : items === undefined ? (
          <div role="status" className="flex items-center gap-3 p-5 text-[#68746d]">
            <Loader2 className="size-5 animate-spin" /> Loading operator keys
          </div>
        ) : items.length === 0 ? (
          <p className="p-5 text-sm text-[#68746d]">No operator keys yet.</p>
        ) : (
          <KeyTable
            keys={items}
            busy={busy}
            onRevoke={credentialId => {
              create.reset();
              revoke.mutate(credentialId);
            }}
          />
        )}
        {revoke.error ? (
          <div className="px-5 pb-5">
            <ErrorNotice error={revoke.error} />
          </div>
        ) : null}
      </section>

      {secret.status === "shown" ? (
        <SecretDialog name={secret.name} token={secret.token} onDone={() => setSecret({ status: "hidden" })} />
      ) : null}
    </div>
  );
}

function CreateKeyForm({
  busy,
  error,
  onCreate,
}: {
  busy: boolean;
  error: unknown;
  /** `onCreated` runs when the server accepted the key, so the form can clear itself. */
  onCreate(input: CreateOperatorKeyInput, onCreated: () => void): void;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [expires, setExpires] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const nameId = useId();
  const expiresId = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseCreateKeyForm({ name, scopes, expires });
    if (!parsed.ok) {
      setFormError(parsed.message);
      return;
    }
    setFormError(null);
    onCreate(parsed.input, () => {
      setName("");
      setScopes([]);
      setExpires("");
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor={nameId}>Name</Label>
          <Input
            id={nameId}
            required
            maxLength={64}
            autoComplete="off"
            placeholder="Routine harness"
            className="w-64"
            value={name}
            onChange={event => setName(event.target.value)}
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
            onChange={event => setExpires(event.target.value)}
          />
        </div>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Scopes</legend>
        {OPERATOR_KEY_SCOPES.map(scope => (
          <label key={scope} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="scope"
              value={scope}
              className="size-4 accent-[#087d50]"
              checked={scopes.includes(scope)}
              onChange={event =>
                setScopes(current => (event.target.checked ? [...current, scope] : current.filter(held => held !== scope)))
              }
            />
            {scopeLabel(scope)}
          </label>
        ))}
      </fieldset>
      <Button type="submit" disabled={busy}>
        Create operator key
      </Button>
      {formError ? <ErrorNotice error={formError} /> : null}
      {error ? <ErrorNotice error={error} /> : null}
    </form>
  );
}

function KeyTable({ keys, busy, onRevoke }: { keys: CredentialView[]; busy: boolean; onRevoke(credentialId: string): void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-[#68746d]">
          <tr>
            <th className="px-5 py-3 font-medium">Key</th>
            <th className="py-3 pr-4 font-medium">Scopes</th>
            <th className="py-3 pr-4 font-medium">Expires</th>
            <th className="py-3 pr-4 font-medium">Last used</th>
            <th className="py-3 pr-5 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#eceeeb] border-t border-[#eceeeb]">
          {keys.map(key => (
            <tr key={key.credentialId} className="align-top">
              <td className="px-5 py-3">
                <div className="font-medium">{key.name}</div>
                <code className="text-xs text-[#68746d]">{key.display}</code>
                <div className="text-xs text-[#a0a3aa]">{createdBy(key)}</div>
              </td>
              <td className="py-3 pr-4">
                <div className="flex flex-wrap gap-1">
                  {key.scopes.map(scope => (
                    <span key={scope} className="rounded-full bg-[#f0f2ef] px-2.5 py-0.5 text-xs font-semibold text-[#4f5d54]">
                      {scopeLabel(scope)}
                    </span>
                  ))}
                </div>
              </td>
              <td className="py-3 pr-4">{key.expiresAt ? formatDate(key.expiresAt) : "Never"}</td>
              <td className="py-3 pr-4">{key.lastUsedAt ? formatDateTime(key.lastUsedAt) : "Never used"}</td>
              <td className="py-3 pr-5 text-right">
                <ConfirmButton
                  label="Revoke"
                  ariaLabel={`Revoke ${key.name}`}
                  prompt={`Revoke ${key.name}? Anything using it stops working.`}
                  confirmLabel="Confirm revoke"
                  disabled={busy}
                  onConfirm={() => onRevoke(key.credentialId)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ErrorNotice({ error }: { error: unknown }) {
  return (
    <p role="alert" className="rounded-[14px] bg-[#fff3f1] p-3 text-sm text-[#a64235]">
      {typeof error === "string" ? error : error instanceof Error ? error.message : "Request failed"}
    </p>
  );
}

function createdBy(key: CredentialView): string {
  if (key.issuedByService) return `Issued by the ${key.issuedByService} service`;
  return key.createdByEmail ? `Created by ${key.createdByEmail}` : "";
}

/** Tomorrow as a `YYYY-MM-DD` value for the date field's `min`: an expiry must be in the future. */
function tomorrow(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
