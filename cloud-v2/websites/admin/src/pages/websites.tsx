import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog, licenseStrings, useAsking } from "@mentra/workspace-ui";
import { Loader2, RefreshCcw } from "lucide-react";
import { useId, useReducer, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "../lib/api";

const PANEL = "rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]";
const SELECT = "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs";
const BASE = "/api/admin/website-clients";

export const WEBSITES_QUERY_KEY = ["admin-website-clients"] as const;

/** A registered miniapp website, as Core lists it: never its secret. */
export interface WebsiteClient {
  clientId: string;
  name: string;
  type: "browser" | "server";
  environment: "production" | "development";
  redirectUris: string[];
  packageName: string;
  /** The developer who registered it in the Developer Console; null for one registered here. */
  ownerUserId: string | null;
  access: "public" | "private";
  accessWorkspaceIds: string[];
  status: "active" | "disabled";
  secretLast4: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWebsiteInput {
  name: string;
  packageName: string;
  type: WebsiteClient["type"];
  environment: WebsiteClient["environment"];
  redirectUris: string[];
  access: WebsiteClient["access"];
  accessWorkspaceIds?: string[];
}

export interface WebsiteForm {
  name: string;
  packageName: string;
  type: string;
  environment: string;
  /** One URL per line. */
  redirectUris: string;
  access: string;
  /** One workspace ID per line or comma. */
  accessWorkspaceIds: string;
}

export const EMPTY_FORM: WebsiteForm = {
  name: "",
  packageName: "",
  type: "server",
  environment: "production",
  redirectUris: "",
  access: "public",
  accessWorkspaceIds: "",
};

export type WebsiteFormResult = { ok: true; input: CreateWebsiteInput } | { ok: false; message: string };

const lines = (value: string) =>
  value
    .split(/[\n,]/)
    .map(entry => entry.trim())
    .filter(Boolean);

/**
 * The request for what the form holds. It catches what a person can fix before sending: an empty field, a
 * redirect that is not a web address, a loopback address on a production site. Core checks everything again
 * and is the one that decides.
 */
export function parseWebsiteForm(form: WebsiteForm): WebsiteFormResult {
  const name = form.name.trim();
  if (!name) return { ok: false, message: "Enter the site's name, as people will see it when they sign in." };
  const packageName = form.packageName.trim();
  if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(packageName)) {
    return { ok: false, message: "Enter the miniapp's package name, such as com.example.notes." };
  }
  const type = form.type === "browser" ? "browser" : "server";
  const environment = form.environment === "development" ? "development" : "production";
  const redirectUris = [...new Set(lines(form.redirectUris))];
  if (redirectUris.length === 0) return { ok: false, message: "Enter at least one redirect URI." };
  for (const uri of redirectUris) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return { ok: false, message: `"${uri}" is not a URL.` };
    }
    const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !loopback) return { ok: false, message: `"${uri}" must start with https://.` };
    if (loopback && environment !== "development") {
      return { ok: false, message: `"${uri}" points at this computer: only a development site may use it.` };
    }
    if (loopback && !url.port) return { ok: false, message: `"${uri}" needs a port, such as http://127.0.0.1:5173/callback.` };
    if (url.hash) return { ok: false, message: `"${uri}" must not contain a # part.` };
  }
  const input: CreateWebsiteInput = { name, packageName, type, environment, redirectUris, access: form.access === "private" ? "private" : "public" };
  if (input.access === "private") {
    const accessWorkspaceIds = [...new Set(lines(form.accessWorkspaceIds))];
    if (accessWorkspaceIds.length === 0) return { ok: false, message: "List the workspaces whose members may sign in." };
    input.accessWorkspaceIds = accessWorkspaceIds;
  }
  return { ok: true, input };
}

export type SecretState = { status: "hidden" } | { status: "shown"; name: string; clientId: string; secret: string };
export type SecretAction = { type: "issued"; name: string; clientId: string; secret: string } | { type: "dismissed" };

/** `hidden` holds nothing; `shown` is the only state that holds the secret, and `dismissed` drops it. */
export function secretReducer(_state: SecretState, action: SecretAction): SecretState {
  return action.type === "issued" ? { status: "shown", name: action.name, clientId: action.clientId, secret: action.secret } : { status: "hidden" };
}

interface Issued {
  client: WebsiteClient;
  secret: string | null;
}

/**
 * The page. A server-type site's secret exists in the `secret` state only, from the answer that created it
 * until Done: not in the query or mutation cache, not in a URL. Its notice is rendered outside the list's
 * loading and error states, so a refetch that fails cannot take it off the screen.
 */
export function WebsitesPage() {
  const client = useQueryClient();
  const [secret, dispatch] = useReducer(secretReducer, { status: "hidden" });
  const sites = useQuery({ queryKey: WEBSITES_QUERY_KEY, queryFn: () => api<{ clients: WebsiteClient[] }>(BASE) });
  const settled = () => client.invalidateQueries({ queryKey: WEBSITES_QUERY_KEY });
  const reveal = ({ client: site, secret: issued }: Issued) => {
    if (issued) dispatch({ type: "issued", name: site.name, clientId: site.clientId, secret: issued });
  };
  const create = useMutation({
    // The secret goes to `reveal` and is not the mutation's result, so it is never cached.
    mutationFn: async (input: CreateWebsiteInput) => {
      const created = await api<Issued>(BASE, { method: "POST", body: input });
      reveal(created);
      return created.client;
    },
    gcTime: 0,
    onSettled: settled,
  });
  const change = useMutation({
    mutationFn: ({ clientId, status }: { clientId: string; status: WebsiteClient["status"] }) =>
      api<{ client: WebsiteClient }>(`${BASE}/${encodeURIComponent(clientId)}`, { method: "PATCH", body: { status } }),
    gcTime: 0,
    onSettled: settled,
  });
  const regenerate = useMutation({
    mutationFn: async (clientId: string) => {
      reveal(await api<Issued>(`${BASE}/${encodeURIComponent(clientId)}/secret`, { method: "POST" }));
    },
    gcTime: 0,
    onSettled: settled,
  });
  const remove = useMutation({
    mutationFn: (clientId: string) => api<void>(`${BASE}/${encodeURIComponent(clientId)}`, { method: "DELETE" }),
    gcTime: 0,
    onSettled: settled,
  });
  const busy = create.isPending || change.isPending || regenerate.isPending || remove.isPending;
  const items = sites.data?.clients;

  return (
    <div className="space-y-6">
      <SecretNotice secret={secret} onDone={() => dispatch({ type: "dismissed" })} />

      <section className={PANEL}>
        <div className="border-b border-[#eceeeb] p-5">
          <h2 className="text-xl font-bold">Register a website</h2>
          <p className="mt-1 text-sm text-[#68746d]">
            A registered website can offer Sign in with Mentra. The person is asked to allow it, and the site then
            reaches their data in one miniapp, through that miniapp's own backend. It never receives a token for
            Mentra itself. Developers register their own in the Developer Console, for a miniapp on their own
            domain; here you can register one for any miniapp at any address, and see and switch off them all.
          </p>
        </div>
        <div className="p-5">
          <WebsiteFormView busy={busy} error={create.error} onCreate={(input, done) => create.mutate(input, { onSuccess: done })} />
        </div>
      </section>

      <section className={PANEL}>
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#eceeeb] p-5">
          <div>
            <h2 className="text-xl font-bold">Websites</h2>
            <p className="mt-1 text-sm text-[#68746d]">
              Disabling a site stops new sign-ins and refreshes at once. People already signed in there are signed out within five minutes.
            </p>
          </div>
          <Button variant="ghost" size="icon" className="rounded-full" onClick={() => sites.refetch()} aria-label="Refresh websites" disabled={sites.isFetching}>
            <RefreshCcw className={`size-4 ${sites.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
        {change.error || regenerate.error ? (
          <div className="px-5 pt-5">
            <ErrorNotice error={change.error ?? regenerate.error} />
          </div>
        ) : null}
        {items === undefined && sites.isError ? (
          <div className="p-5">
            <ErrorNotice error={sites.error} />
          </div>
        ) : items === undefined ? (
          <div role="status" className="flex items-center gap-3 p-5 text-[#68746d]">
            <Loader2 className="size-5 animate-spin" /> Loading websites
          </div>
        ) : items.length === 0 ? (
          <p className="p-5 text-sm text-[#68746d]">No websites are registered yet.</p>
        ) : (
          <WebsiteTable
            sites={items}
            busy={busy}
            onStatus={(clientId, status) => change.mutate({ clientId, status })}
            onRegenerate={clientId => regenerate.mutateAsync(clientId)}
            onRemove={clientId => remove.mutateAsync(clientId)}
          />
        )}
      </section>
    </div>
  );
}

/** The one-time notice while a secret is held, and nothing otherwise. Only Done dismisses it. */
export function SecretNotice({ secret, onDone }: { secret: SecretState; onDone(): void }) {
  const [copied, setCopied] = useState(false);
  if (secret.status !== "shown") return null;
  return (
    <section role="alert" className="rounded-[24px] border border-[#087d50] bg-[#f1faf5] p-5">
      <h2 className="text-lg font-bold">Copy the client secret for {secret.name}</h2>
      <p className="mt-1 text-sm text-[#4f5d54]">
        This is the only time it is shown. Keep it on the site's server, never in a browser or a repository. If it is
        lost, regenerate it.
      </p>
      <dl className="mt-4 grid gap-3 text-sm">
        <div>
          <dt className="font-medium">Client ID</dt>
          <dd>
            <code className="break-all">{secret.clientId}</code>
          </dd>
        </div>
        <div>
          <dt className="font-medium">Client secret</dt>
          <dd>
            <code className="break-all">{secret.secret}</code>
          </dd>
        </div>
      </dl>
      <div className="mt-4 flex gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(secret.secret).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy secret"}
        </Button>
        <Button
          type="button"
          onClick={() => {
            setCopied(false);
            onDone();
          }}
        >
          Done
        </Button>
      </div>
    </section>
  );
}

function WebsiteFormView({ busy, error, onCreate }: { busy: boolean; error: unknown; onCreate(input: CreateWebsiteInput, done: () => void): void }) {
  const [form, setForm] = useState<WebsiteForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const id = useId();
  const set = (field: keyof WebsiteForm) => (event: { target: { value: string } }) => setForm(current => ({ ...current, [field]: event.target.value }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseWebsiteForm(form);
    if (!parsed.ok) {
      setFormError(parsed.message);
      return;
    }
    setFormError(null);
    onCreate(parsed.input, () => setForm(EMPTY_FORM));
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input id={`${id}-name`} required maxLength={80} autoComplete="off" placeholder="Notes" className="w-56" value={form.name} onChange={set("name")} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-package`}>Miniapp package</Label>
          <Input id={`${id}-package`} required maxLength={128} autoComplete="off" placeholder="com.example.notes" className="w-64" value={form.packageName} onChange={set("packageName")} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-type`}>Type</Label>
          <select id={`${id}-type`} className={SELECT} value={form.type} onChange={set("type")}>
            <option value="server">Server (keeps a secret)</option>
            <option value="browser">Browser (no secret)</option>
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-environment`}>Environment</Label>
          <select id={`${id}-environment`} className={SELECT} value={form.environment} onChange={set("environment")}>
            <option value="production">Production</option>
            <option value="development">Development</option>
          </select>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-redirects`}>Redirect URIs, one per line</Label>
        <textarea
          id={`${id}-redirects`}
          required
          rows={2}
          spellCheck={false}
          placeholder="https://notes.example.com/auth/callback"
          className="w-full max-w-xl rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs"
          value={form.redirectUris}
          onChange={set("redirectUris")}
        />
        <p className="text-xs text-[#68746d]">Matched exactly. HTTPS only; a development site may also use http://127.0.0.1 or localhost with a port.</p>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-access`}>Who may sign in</Label>
          <select id={`${id}-access`} className={SELECT} value={form.access} onChange={set("access")}>
            <option value="public">Anyone with a Mentra account</option>
            <option value="private">Members of listed workspaces</option>
          </select>
        </div>
        {form.access === "private" ? (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-access-workspaces`}>Workspace IDs</Label>
            <Input id={`${id}-access-workspaces`} autoComplete="off" placeholder="ws_…, ws_…" className="w-72" value={form.accessWorkspaceIds} onChange={set("accessWorkspaceIds")} />
          </div>
        ) : null}
      </div>
      <Button type="submit" disabled={busy}>
        Register website
      </Button>
      {formError ? <ErrorNotice error={formError} /> : null}
      {error ? <ErrorNotice error={error} /> : null}
    </form>
  );
}

type Asked = { site: WebsiteClient; act: "regenerate" | "remove" };

export function WebsiteTable({
  sites,
  busy,
  onStatus,
  onRegenerate,
  onRemove,
}: {
  sites: WebsiteClient[];
  busy: boolean;
  onStatus(clientId: string, status: WebsiteClient["status"]): void;
  onRegenerate(clientId: string): Promise<void>;
  onRemove(clientId: string): Promise<void>;
}) {
  const ask = useAsking<Asked>(asked => `${asked.act}:${asked.site.clientId}`, busy);
  const asking = ask.asking;
  const cancelLabel = licenseStrings.confirm.cancel;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-[#68746d]">
          <tr>
            <th className="px-5 py-3 font-medium">Website</th>
            <th className="py-3 pr-4 font-medium">Miniapp</th>
            <th className="py-3 pr-4 font-medium">Redirect URIs</th>
            <th className="py-3 pr-4 font-medium">Who may sign in</th>
            <th className="py-3 pr-5 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#eceeeb] border-t border-[#eceeeb]">
          {sites.map(site => {
            const all = sites.map(entry => ({ site: entry, act: "remove" as const }));
            return (
              <tr key={site.clientId} className="align-top">
                <td className="px-5 py-3">
                  <div className="font-medium">
                    {site.name}{" "}
                    {site.status === "disabled" ? (
                      <span className="rounded-full bg-[#fff3f1] px-2 py-0.5 text-xs font-semibold text-[#a64235]">Disabled</span>
                    ) : null}
                  </div>
                  <code className="text-xs text-[#68746d]">{site.clientId}</code>
                  <div className="text-xs text-[#a0a3aa]">
                    {site.type === "server" ? `Server · secret ends ${site.secretLast4 ?? "…"}` : "Browser · no secret"} · {site.environment}
                  </div>
                </td>
                <td className="py-3 pr-4">
                  <code className="text-xs">{site.packageName}</code>
                  <div className="text-xs text-[#a0a3aa]">{site.ownerUserId ? `Registered by its developer (${site.ownerUserId})` : "Registered here"}</div>
                </td>
                <td className="py-3 pr-4">
                  {site.redirectUris.map(uri => (
                    <code key={uri} className="block break-all text-xs">
                      {uri}
                    </code>
                  ))}
                </td>
                <td className="py-3 pr-4">
                  {site.ownerUserId && site.environment === "development" ? "Only its developer" : site.access === "public" ? "Anyone" : `Members of ${site.accessWorkspaceIds.join(", ")}`}
                </td>
                <td className="py-3 pr-5">
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={`${site.status === "active" ? "Disable" : "Enable"} ${site.name}`}
                      onClick={() => onStatus(site.clientId, site.status === "active" ? "disabled" : "active")}
                    >
                      {site.status === "active" ? "Disable" : "Enable"}
                    </Button>
                    {site.type === "server" ? (
                      <Button
                        ref={ask.trigger(`regenerate:${site.clientId}`)}
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        aria-label={`Regenerate the secret of ${site.name}`}
                        onClick={() => ask.ask({ site, act: "regenerate" }, sites.map(entry => ({ site: entry, act: "regenerate" as const })))}
                      >
                        New secret
                      </Button>
                    ) : null}
                    <Button
                      ref={ask.trigger(`remove:${site.clientId}`)}
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      aria-label={`Remove ${site.name}`}
                      onClick={() => ask.ask({ site, act: "remove" }, all)}
                    >
                      Remove
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {asking ? (
        <ConfirmDialog
          title={asking.act === "remove" ? `Remove ${asking.site.name}?` : `Replace the secret of ${asking.site.name}?`}
          description={
            asking.act === "remove"
              ? "The site can no longer sign anyone in, and everyone signed in there is signed out within five minutes. This cannot be undone."
              : "The current secret stops working at once. The site cannot sign anyone in until it has the new one."
          }
          cancelLabel={cancelLabel}
          confirmLabel={asking.act === "remove" ? "Remove website" : "Replace secret"}
          onConfirm={async () => {
            try {
              await (asking.act === "remove" ? onRemove(asking.site.clientId) : onRegenerate(asking.site.clientId));
              return null;
            } catch (error) {
              return error instanceof Error ? error.message : "Request failed";
            }
          }}
          onClose={ask.close}
        />
      ) : null}
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
