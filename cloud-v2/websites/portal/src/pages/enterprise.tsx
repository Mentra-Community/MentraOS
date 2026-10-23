/**
 * The enterprise pages: an enterprise org and the trusted identity issuers Mentra accepts for its people.
 *
 * Company sign-in returns as workspace settings in a later phase. Until then these pages are not in the
 * portal's navigation: they are reachable only by direct address (`/enterprise`, `/enterprise/environments`,
 * `/enterprise/access`), and Core's `/api/portal/org` and `/api/portal/trusted-issuers` routes are unchanged.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, buttonVariants, Input, Label, Spinner, type NavGroup } from "@mentra/workspace-ui";
import { Building2, Clock, Fingerprint, Globe2, Loader2, Mail, Plus, ShieldCheck, ToggleLeft, ToggleRight, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { PortalShell } from "@/components/portal-shell";
import { api, type EnterpriseOrg, type PortalMe, type PortalUser } from "@/lib/api";
import { enterprisePath, type EnterprisePage } from "@/lib/routes";

type TrustedIssuer = {
  id: string;
  environmentName: string;
  issuer: string;
  jwksUrl: string;
  subjectClaim: string;
  enabled: boolean;
  updatedBy?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type JwksValidation = { reachable: boolean; keyCount: number; algorithms: string[]; error?: string };

const PAGE_META: Record<EnterprisePage, { title: string; description: string }> = {
  overview: { title: "Enterprise", description: "Enterprise account status and runtime setup." },
  environments: { title: "Auth environments", description: "Manage trusted issuer and JWKS configuration." },
  access: { title: "Enterprise access", description: "Manage enterprise members and approval state." },
};

/** The enterprise pages: set-up until a Mentra admin approves the enterprise org, then its three pages. */
function enterpriseNav(approved: boolean): NavGroup[] {
  const items = approved
    ? [
        { key: "overview", label: "Enterprise", icon: Building2, href: enterprisePath("overview") },
        { key: "environments", label: "Auth environments", icon: Fingerprint, href: enterprisePath("environments") },
        { key: "access", label: "Enterprise access", icon: Users, href: enterprisePath("access") },
      ]
    : [{ key: "overview", label: "Enterprise", icon: Building2, href: enterprisePath("overview") }];
  return [{ key: "enterprise", items }];
}

export function EnterpriseScreen({ page, me }: { page: EnterprisePage; me: PortalMe }) {
  const qc = useQueryClient();
  const issuers = useQuery({
    queryKey: ["trusted-issuers"],
    queryFn: () => api<{ org: EnterpriseOrg; issuers: TrustedIssuer[] }>("/api/portal/trusted-issuers"),
    enabled: me.org?.status === "active",
  });
  const org = me.org ?? issuers.data?.org ?? null;
  const approved = org?.status === "active";
  const active: EnterprisePage = approved ? page : "overview";
  const meta = approved
    ? PAGE_META[active]
    : { title: "Enterprise", description: "Set up an enterprise org to manage the identity issuers Mentra trusts for your people." };

  return (
    <PortalShell current={null} nav={enterpriseNav(approved)} activeKey={active} title={meta.title} description={meta.description}>
      {!approved ? (
        org ? (
          <ApprovalPending org={org} />
        ) : (
          <EnterpriseOnboarding
            user={me.user}
            onSaved={async () => {
              await Promise.all([
                qc.invalidateQueries({ queryKey: ["portal-me"] }),
                qc.invalidateQueries({ queryKey: ["trusted-issuers"] }),
              ]);
            }}
          />
        )
      ) : null}
      {approved && active === "overview" && org ? <EnterpriseOverview org={org} issuers={issuers.data?.issuers ?? []} /> : null}
      {approved && active === "environments" && org ? (
        <EnvironmentsPage
          org={org}
          issuers={issuers.data?.issuers ?? []}
          loading={issuers.isLoading}
          onChanged={async () => {
            await qc.invalidateQueries({ queryKey: ["trusted-issuers"] });
          }}
        />
      ) : null}
      {approved && active === "access" && org ? <EnterpriseAccess org={org} /> : null}
    </PortalShell>
  );
}

function EnterpriseOnboarding({ user, onSaved }: { user: PortalUser; onSaved: () => Promise<void> }) {
  return (
    <div className="space-y-7">
      <div>
        <div className="text-muted-foreground inline-flex h-8 items-center gap-2 rounded-full border px-3.5 text-xs font-semibold">
          <Building2 className="text-brand size-3.5" />
          Step 1 · Set up your enterprise organization
        </div>
        <h1 className="mt-4 text-2xl leading-tight font-semibold">Create your enterprise organization</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Register your organization to manage the trusted identity issuers Mentra accepts for your runtime. New orgs are reviewed by a Mentra admin before configuration unlocks — or accept an invite if your company already has an account.
        </p>
      </div>
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <OrgPanel org={null} user={user} onSaved={onSaved} />
        <section className="space-y-4">
          <InfoCard icon={<ShieldCheck className="size-5" />} title="Approval required" body="Creating an enterprise account submits it for admin approval. Runtime issuer configuration stays locked until approval." />
          <InfoCard icon={<Users className="size-5" />} title="Invited orgs" body="If an admin invited you to an existing enterprise org, accept that invite instead of creating a new account." />
          <InfoCard icon={<Building2 className="size-5" />} title="Request access" body="If your company already has an enterprise account, request access from that org owner." />
        </section>
      </div>
    </div>
  );
}

function ApprovalPending({ org }: { org: EnterpriseOrg }) {
  return (
    <div className="space-y-6">
      <section className="bg-card rounded-card border p-8">
        <div className="flex max-w-2xl gap-5">
          <div className="bg-error text-error-foreground flex size-14 shrink-0 items-center justify-center rounded-[16px]">
            <Clock className="size-7" />
          </div>
          <div>
            <span className="bg-error text-error-foreground inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold">Request submitted</span>
            <h2 className="mt-3 text-2xl leading-tight font-semibold">Waiting for admin approval</h2>
            <p className="text-muted-foreground mt-2">
              <span className="text-foreground font-semibold">{org.name}</span> is in the review queue. Trusted issuer and JWKS management unlocks as soon as a Mentra admin approves your enterprise account, and we'll email you when it's ready.
            </p>
            <div className="rounded-notice bg-surface mt-5 p-4">
              <div className="text-muted-foreground text-xs font-semibold">Your tenant ID</div>
              <div className="mt-1 font-mono text-sm">{org.tenantId}</div>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <InfoCard
          icon={<ShieldCheck className="size-5" />}
          title="What Mentra is reviewing"
          body="We confirm your organization details and that you're authorized to manage auth issuers for this company before unlocking configuration."
        />
        <InfoCard
          icon={<Mail className="size-5" />}
          title="Need it sooner?"
          body="Reply to your Mentra onboarding thread or reach your Mentra representative to expedite review."
        />
      </div>
    </div>
  );
}

function EnterpriseOverview({ org, issuers }: { org: EnterpriseOrg; issuers: TrustedIssuer[] }) {
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
      <section className="bg-card rounded-card border p-6">
        <p className="text-info-foreground text-sm font-semibold">Approved enterprise</p>
        <h2 className="mt-2 text-3xl leading-tight font-semibold">{org.name}</h2>
        <p className="text-muted-foreground mt-3 max-w-2xl">Configure sandbox and production issuers so your runtime can verify exchange tokens.</p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Metric label="Tenant ID" value={org.tenantId} />
          <Metric label="Trusted issuers" value={String(issuers.length)} />
        </div>
      </section>
      <ReferencePanel org={org} />
    </div>
  );
}

function EnterpriseAccess({ org }: { org: EnterpriseOrg }) {
  return (
    <section className="bg-card rounded-card border">
      <div className="border-b p-6">
        <h2 className="text-lg font-semibold">Enterprise access</h2>
        <p className="text-muted-foreground mt-1 text-sm">Members and invitations are managed here.</p>
      </div>
      <div className="p-6">
        <div className="rounded-notice bg-surface p-5">
          <div className="text-muted-foreground text-sm">Current org</div>
          <div className="mt-1 text-lg font-semibold">{org.name}</div>
          <span className="bg-info text-info-foreground mt-4 inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold">Approved</span>
        </div>
      </div>
    </section>
  );
}

function InfoCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="bg-card rounded-card border p-6">
      <div className="bg-info text-info-foreground flex size-11 items-center justify-center rounded-[14px]">{icon}</div>
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      <p className="text-muted-foreground mt-1.5 text-sm">{body}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-notice bg-surface p-4">
      <div className="text-muted-foreground text-sm">{label}</div>
      <div className="mt-1 font-mono text-lg font-semibold">{value}</div>
    </div>
  );
}

function OrgPanel({ org, user, onSaved }: { org: EnterpriseOrg | null; user: PortalUser; onSaved: () => Promise<void> }) {
  const [displayName, setDisplayName] = useState(org?.name ?? suggestedOrgName(user.email));
  const [tenantId, setTenantId] = useState(org?.tenantId ?? suggestedTenantId(user.email));
  const saveOrg = useMutation({
    mutationFn: () => api<{ org: EnterpriseOrg }>("/api/portal/org", {
      method: "PUT",
      body: { displayName, tenantId },
    }),
    onSuccess: onSaved,
  });

  useEffect(() => {
    if (!org) return;
    setDisplayName(org.name);
    setTenantId(org.tenantId);
  }, [org]);

  const canSave = displayName.trim().length > 1 && tenantId.trim().length > 2 && !saveOrg.isPending;

  return (
    <section className="bg-card rounded-card border">
      <div className="border-b p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{org ? "Enterprise org" : "Create enterprise org"}</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              This org owns the Tenant ID that is embedded in trusted exchange tokens.
            </p>
          </div>
          {org ? (
            <span className="bg-info text-info-foreground inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold">Active</span>
          ) : null}
        </div>
      </div>
      <form
        className="space-y-4 p-6"
        onSubmit={event => {
          event.preventDefault();
          if (canSave) saveOrg.mutate();
        }}
      >
        <Field label="Organization name">
          <Input value={displayName} onChange={event => setDisplayName(event.target.value)} className="h-12" placeholder="Acme Optical" />
        </Field>
        <Field label="Tenant ID">
          <Input
            value={tenantId}
            onChange={event => setTenantId(event.target.value.toLowerCase().replace(/\s+/g, ""))}
            className="h-12 font-mono"
            placeholder="acme"
            disabled={Boolean(org)}
          />
        </Field>
        <div className="rounded-notice bg-surface text-muted-foreground p-4 text-sm">
          <span className="text-foreground font-semibold">Issuer lookup:</span> your tokens must carry this id as the <span className="font-mono">tenantId</span> claim (plus an <span className="font-mono">env</span> claim) so the runtime can find the right issuer configuration.
        </div>
        {saveOrg.isError ? <ErrorText error={saveOrg.error} /> : null}
        <Button size="lg" className="w-full" disabled={!canSave}>
          {saveOrg.isPending ? "Saving..." : org ? "Save changes" : "Create org"}
        </Button>
      </form>
    </section>
  );
}

function EnvironmentsPage({ org, issuers, loading, onChanged }: { org: EnterpriseOrg; issuers: TrustedIssuer[]; loading: boolean; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState<TrustedIssuer | null>(null);
  return (
    <section className="space-y-6">
      <IssuerForm
        disabled={!org}
        editing={editing}
        onCancelEdit={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await onChanged();
        }}
      />
      <IssuerList issuers={issuers} loading={loading} onChanged={onChanged} onEdit={setEditing} />
      <ReferencePanel org={org} />
    </section>
  );
}

function IssuerForm({ disabled, editing, onCancelEdit, onSaved }: { disabled: boolean; editing: TrustedIssuer | null; onCancelEdit: () => void; onSaved: () => Promise<void> }) {
  const [environmentName, setEnvironmentName] = useState("sandbox");
  const [issuer, setIssuer] = useState("");
  const [jwksUrl, setJwksUrl] = useState("");
  const [subjectClaim, setSubjectClaim] = useState("sub");
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (!editing) return;
    setEnvironmentName(editing.environmentName);
    setIssuer(editing.issuer);
    setJwksUrl(editing.jwksUrl);
    setSubjectClaim(editing.subjectClaim);
    setShowAdvanced(editing.subjectClaim !== "sub");
  }, [editing]);

  const save = useMutation({
    mutationFn: () => api<{ issuer: TrustedIssuer }>("/api/portal/trusted-issuers", {
      method: "POST",
      body: { environmentName, issuer, jwksUrl, subjectClaim },
    }),
    onSuccess: async () => {
      if (!editing) {
        setIssuer("");
        setJwksUrl("");
        setSubjectClaim("sub");
        setShowAdvanced(false);
      }
      await onSaved();
    },
  });

  const validate = useMutation({
    mutationFn: () => api<{ validation: JwksValidation }>("/api/portal/trusted-issuers/validate", {
      method: "POST",
      body: { jwksUrl },
    }),
  });

  const canSubmit = !disabled && Boolean(environmentName && issuer && jwksUrl) && !save.isPending;

  function reset() {
    setEnvironmentName("sandbox");
    setIssuer("");
    setJwksUrl("");
    setSubjectClaim("sub");
    setShowAdvanced(false);
    validate.reset();
    onCancelEdit();
  }

  return (
    <section className="bg-card rounded-card border">
      <div className="border-b p-6">
        <div className="flex items-start gap-3">
          <div className="bg-info text-info-foreground flex size-11 shrink-0 items-center justify-center rounded-[14px]">
            <Fingerprint className="size-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">{editing ? `Edit ${editing.environmentName} issuer` : "Add trusted issuer"}</h2>
            <p className="text-muted-foreground mt-1 text-sm">Use exact HTTPS issuer URLs. Query strings and fragments are rejected.</p>
          </div>
        </div>
      </div>
      <form
        className="grid gap-4 p-6 md:grid-cols-2"
        onSubmit={event => {
          event.preventDefault();
          if (canSubmit) save.mutate();
        }}
      >
        <Field label="Environment">
          <Input value={environmentName} onChange={event => setEnvironmentName(event.target.value)} className="h-12" placeholder="sandbox" disabled={disabled || Boolean(editing)} />
          {editing ? <p className="text-muted-foreground mt-1.5 text-xs">Environment is the lookup key and can't be changed; remove and re-add to rename.</p> : null}
        </Field>
        <Field label="Issuer URL">
          <Input value={issuer} onChange={event => setIssuer(event.target.value)} className="h-12 font-mono" placeholder="https://auth.acme.com" disabled={disabled} />
        </Field>
        <div className="md:col-span-2">
          <Field label="JWKS URL">
            <div className="flex flex-wrap gap-2">
              <Input value={jwksUrl} onChange={event => { setJwksUrl(event.target.value); validate.reset(); }} className="h-12 min-w-[240px] flex-1 font-mono" placeholder="https://auth.acme.com/.well-known/jwks.json" disabled={disabled} />
              <Button
                type="button"
                variant="secondary"
                size="lg"
                disabled={disabled || !jwksUrl || validate.isPending}
                onClick={() => validate.mutate()}
              >
                {validate.isPending ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
                Test
              </Button>
            </div>
            <JwksResult result={validate.data?.validation} error={validate.error} />
          </Field>
        </div>

        <div className="md:col-span-2">
          <button type="button" className={buttonVariants({ variant: "link", className: "text-sm" })} onClick={() => setShowAdvanced(value => !value)}>
            {showAdvanced ? "Hide advanced" : "Advanced — subject claim"}
          </button>
          {showAdvanced ? (
            <div className="mt-3">
              <Field label="Subject claim">
                <Input value={subjectClaim} onChange={event => setSubjectClaim(event.target.value)} className="h-12 font-mono" placeholder="sub" disabled={disabled} />
                <p className="text-muted-foreground mt-1.5 text-xs">Which claim holds the user id. Defaults to <span className="font-mono">sub</span> — only change it if your IdP puts the id elsewhere.</p>
              </Field>
            </div>
          ) : null}
        </div>

        <div className="md:col-span-2">
          {save.isError ? <ErrorText error={save.error} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={!canSubmit}>
              <Plus className="size-4" />
              {editing ? (save.isPending ? "Saving..." : "Update issuer") : (save.isPending ? "Adding..." : "Add issuer")}
            </Button>
            {editing ? (
              <Button type="button" variant="secondary" onClick={reset}>Cancel</Button>
            ) : null}
          </div>
        </div>
      </form>
    </section>
  );
}

function JwksResult({ result, error }: { result?: JwksValidation; error: unknown }) {
  if (error) return <p className="text-error-foreground mt-2 text-sm">{error instanceof Error ? error.message : "Validation failed"}</p>;
  if (!result) return null;
  if (!result.reachable || result.error) {
    return <p className="text-error-foreground mt-2 text-sm font-semibold">✕ {result.error ?? "Unreachable"}</p>;
  }
  return (
    <p className="text-info-foreground mt-2 text-sm font-semibold">
      ✓ Reachable · {result.keyCount} key{result.keyCount === 1 ? "" : "s"}{result.algorithms.length ? ` · ${result.algorithms.join(", ")}` : ""}
    </p>
  );
}

function IssuerList({ issuers, loading, onChanged, onEdit }: { issuers: TrustedIssuer[]; loading: boolean; onChanged: () => Promise<void>; onEdit: (issuer: TrustedIssuer) => void }) {
  const toggle = useMutation({
    mutationFn: (input: { id: string; enabled: boolean }) => api<{ issuer: TrustedIssuer }>(`/api/portal/trusted-issuers/${input.id}`, {
      method: "PATCH",
      body: { enabled: input.enabled },
    }),
    onSuccess: onChanged,
  });

  return (
    <section className="bg-card rounded-card border">
      <div className="flex items-center justify-between gap-4 border-b p-6">
        <div>
          <h2 className="text-lg font-semibold">Trusted issuers</h2>
          <p className="text-muted-foreground mt-1 text-sm">Each environment maps one issuer URL to one JWKS endpoint.</p>
        </div>
        <span className="bg-surface text-muted-foreground inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold">{issuers.length} total</span>
      </div>
      {loading ? (
        <div className="p-6"><InlineLoading label="Loading issuers" /></div>
      ) : issuers.length === 0 ? (
        <div className="flex min-h-[220px] flex-col items-center justify-center p-6 text-center">
          <Fingerprint className="text-brand size-10" />
          <h3 className="mt-4 text-lg font-semibold">No issuers yet</h3>
          <p className="text-muted-foreground mt-2 max-w-md text-sm">Register the sandbox or production issuer your auth backend signs with. Tokens route by <span className="font-mono">tenantId</span> + <span className="font-mono">env</span>; the issuer URL is validated against the token's <span className="font-mono">iss</span>.</p>
        </div>
      ) : (
        <div className="divide-y">
          {issuers.map(issuer => (
            <div key={issuer.id} className="grid gap-4 p-6 md:grid-cols-[150px_1fr_auto] md:items-center">
              <div>
                <div className="text-sm font-semibold">{issuer.environmentName}</div>
                <span className={`mt-1 inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold ${issuer.enabled ? "bg-info text-info-foreground" : "bg-error text-error-foreground"}`}>
                  {issuer.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <div className="min-w-0">
                <div className="truncate font-mono text-sm">{issuer.issuer}</div>
                <div className="text-muted-foreground mt-1 truncate font-mono text-xs">{issuer.jwksUrl}</div>
                {issuer.updatedAt ? (
                  <div className="text-muted-foreground mt-1 truncate text-xs">
                    Updated {formatDate(issuer.updatedAt)}{issuer.updatedBy ? ` · ${issuer.updatedBy}` : ""}
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => onEdit(issuer)}>Edit</Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate({ id: issuer.id, enabled: !issuer.enabled })}
                >
                  {issuer.enabled ? <ToggleRight className="text-brand size-5" /> : <ToggleLeft className="size-5" />}
                  {issuer.enabled ? "Disable" : "Enable"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ReferencePanel({ org }: { org: EnterpriseOrg | null }) {
  return (
    <section className="bg-primary text-primary-foreground rounded-card p-6">
      <div className="flex items-center gap-3">
        <Globe2 className="text-brand size-5" />
        <h2 className="text-lg font-semibold">Token exchange contract</h2>
      </div>
      <p className="mt-2 max-w-2xl text-sm text-white/60">
        These are the claims your exchange token must carry. We route on <span className="font-mono text-white/80">tenantId</span> + <span className="font-mono text-white/80">env</span> to find your issuer config; <span className="font-mono text-white/80">iss</span> stays a real URL and is validated against what you registered.
      </p>
      <div className="rounded-notice text-info mt-4 grid gap-2 bg-white/10 p-4 font-mono text-sm leading-7 sm:grid-cols-2">
        <div><span className="text-white/45">tenantId</span> = {org?.tenantId ?? "create-org-first"}</div>
        <div><span className="text-white/45">env</span> = sandbox | prod | ...</div>
        <div><span className="text-white/45">iss</span> = trusted issuer URL (pinned)</div>
        <div><span className="text-white/45">aud</span> = cloud-runtime</div>
        <div><span className="text-white/45">sub</span> = your user id (or subjectClaim)</div>
      </div>
    </section>
  );
}

function InlineLoading({ label }: { label: string }) {
  return (
    <div className="text-muted-foreground flex items-center gap-2.5 text-sm">
      <Spinner />
      {label}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // The label wraps its field, which would otherwise inherit the label's weight.
    <Label className="block font-normal">
      <span className="mb-2 block text-sm font-semibold">{label}</span>
      {children}
    </Label>
  );
}

function ErrorText({ error }: { error: unknown }) {
  return (
    <div className="rounded-notice bg-error text-error-foreground mb-3 px-4 py-3 text-sm">
      {error instanceof Error ? error.message : "Request failed"}
    </div>
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function suggestedOrgName(email: string | null): string {
  const domain = email?.split("@")[1]?.split(".")[0];
  return domain ? `${domain[0].toUpperCase()}${domain.slice(1)} Enterprise` : "Acme Enterprise";
}

function suggestedTenantId(email: string | null): string {
  return (email?.split("@")[1]?.split(".")[0] ?? "acme").toLowerCase().replace(/[^a-z0-9_-]/g, "");
}
