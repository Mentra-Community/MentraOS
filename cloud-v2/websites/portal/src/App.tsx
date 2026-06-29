import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Clock, Fingerprint, Globe2, Loader2, LogOut, Mail, Plus, ShieldCheck, ToggleLeft, ToggleRight, Users } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { AppShell, type NavItem } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import mentraLogo from "./assets/mentra-logo.svg";

type EnterpriseOrg = {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  status: "active" | "disabled" | "pending";
};
type PortalPageKey = "overview" | "environments" | "access";

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

type PortalUser = {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <PortalPage />
    </QueryClientProvider>
  );
}

const PORTAL_NAV: readonly NavItem[] = [
  { key: "overview", label: "Overview", icon: Building2 },
  { key: "environments", label: "Auth environments", icon: Fingerprint },
  { key: "access", label: "Access", icon: Users },
];

const PORTAL_PAGE_META: Record<PortalPageKey, { title: string; description: string }> = {
  overview: { title: "Overview", description: "Enterprise account status and runtime setup." },
  environments: { title: "Auth environments", description: "Manage trusted issuer and JWKS configuration." },
  access: { title: "Access", description: "Manage enterprise members and approval state." },
};

function PortalPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState<PortalPageKey>("overview");
  const [signingOut, setSigningOut] = useState(false);
  const me = useQuery({
    queryKey: ["portal-me"],
    queryFn: () => api<{ authenticated: true; user: PortalUser; onboardingRequired: boolean; org: EnterpriseOrg | null }>("/api/portal/me"),
    retry: false,
  });
  const issuers = useQuery({
    queryKey: ["trusted-issuers"],
    queryFn: () => api<{ org: EnterpriseOrg; issuers: TrustedIssuer[] }>("/api/portal/trusted-issuers"),
    enabled: Boolean(me.data?.org),
  });

  if (me.isLoading) return <Splash label="Checking enterprise session" />;
  if (me.isError) return <LoginGate />;

  const org = me.data?.org ?? issuers.data?.org ?? null;
  const displayName =
    [me.data?.user.firstName, me.data?.user.lastName].filter(Boolean).join(" ") || me.data?.user.email || "Enterprise user";
  const approved = org?.status === "active";

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/console/auth/logout", { method: "POST", headers: { accept: "application/json" } });
    } catch {
      // best-effort; reload still drops us at the login gate
    }
    window.location.reload();
  }

  // Onboarding (no org) and pending approval are focused, nav-free states —
  // the issuer/environment pages stay locked until a Mentra admin approves.
  if (!org) {
    return (
      <FocusShell userLabel={displayName} onSignOut={signOut} signingOut={signingOut}>
        <EnterpriseOnboarding
          user={me.data?.user ?? { id: "preview", email: displayName }}
          onSaved={async () => {
            await Promise.all([
              qc.invalidateQueries({ queryKey: ["portal-me"] }),
              qc.invalidateQueries({ queryKey: ["trusted-issuers"] }),
            ]);
          }}
        />
      </FocusShell>
    );
  }

  if (!approved) {
    return (
      <FocusShell userLabel={displayName} onSignOut={signOut} signingOut={signingOut}>
        <ApprovalPending org={org} />
      </FocusShell>
    );
  }

  const meta = PORTAL_PAGE_META[page];

  return (
    <AppShell
      brandTitle="Enterprise"
      brandSubtitle="Portal"
      badge={
        <div className="rounded-[10px] border border-[#e0e4de] bg-[#f7f8f6] px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#a0a3aa]">Organization</div>
          <div className="truncate text-sm font-semibold text-[#1c1d22]">{org.name}</div>
        </div>
      }
      nav={PORTAL_NAV}
      activeKey={page}
      onSelect={key => setPage(key as PortalPageKey)}
      title={meta.title}
      description={meta.description}
      userEmail={displayName}
      accountLabel="Enterprise"
      onSignOut={signOut}
      signingOut={signingOut}
    >
      {page === "overview" ? <EnterpriseOverview org={org} issuers={issuers.data?.issuers ?? []} /> : null}
      {page === "environments" ? (
        <EnvironmentsPage
          org={org}
          issuers={issuers.data?.issuers ?? []}
          loading={issuers.isLoading}
          onChanged={async () => {
            await qc.invalidateQueries({ queryKey: ["trusted-issuers"] });
          }}
        />
      ) : null}
      {page === "access" ? <EnterpriseAccess org={org} /> : null}
    </AppShell>
  );
}

/** Focused, nav-free layout for the onboarding + approval-pending states. */
function FocusShell({
  children,
  userLabel,
  onSignOut,
  signingOut,
}: {
  children: ReactNode;
  userLabel: string;
  onSignOut: () => void;
  signingOut?: boolean;
}) {
  return (
    <div className="min-h-dvh bg-[#f5f6f4] text-[#14151b]">
      <header className="border-b border-[#e4e6e2] bg-white">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-5">
          <div className="flex items-center gap-3">
            <img src={mentraLogo} alt="" className="h-[22px] w-[41px]" />
            <div>
              <div className="font-display text-[15px] font-bold leading-5 text-[#14151b]">Enterprise Portal</div>
              <div className="text-xs leading-4 text-[#8a8d95]">MentraOS · {userLabel}</div>
            </div>
          </div>
          <button
            type="button"
            className="flex items-center gap-2 rounded-full border border-[#e0e4de] px-4 py-2 text-sm font-medium text-[#5d6068] hover:bg-[#f3f4f2] disabled:opacity-60"
            disabled={signingOut}
            onClick={onSignOut}
          >
            <LogOut className="size-4" />
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-10">{children}</main>
    </div>
  );
}

function EnterpriseOnboarding({ user, onSaved }: { user: PortalUser; onSaved: () => Promise<void> }) {
  return (
    <div className="space-y-7">
      <div>
        <div className="inline-flex items-center gap-2 rounded-full border border-[#dfe3dc] bg-white px-3 py-1 text-xs font-medium text-[#5d6068]">
          <Building2 className="size-3.5 text-[#087d50]" />
          Step 1 · Set up your enterprise organization
        </div>
        <h1 className="mt-4 font-display text-[28px] font-bold leading-tight text-[#14151b]">Create your enterprise organization</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#68746d]">
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
      <section className="rounded-[24px] border border-[#e0e4de] bg-white p-8 shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
        <div className="flex max-w-2xl gap-5">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-[18px] bg-[#fff7df] text-[#a66a00]">
            <Clock className="size-7" />
          </div>
          <div>
            <span className="inline-flex rounded-full border border-[#f0e2b6] bg-[#fff7df] px-3 py-1 text-xs font-semibold text-[#a66a00]">Request submitted</span>
            <h2 className="mt-3 text-2xl font-bold tracking-[-0.03em]">Waiting for admin approval</h2>
            <p className="mt-2 leading-7 text-[#68746d]">
              <span className="font-medium text-[#1c1d22]">{org.name}</span> is in the review queue. Trusted issuer and JWKS management unlocks as soon as a Mentra admin approves your enterprise account, and we'll email you when it's ready.
            </p>
            <div className="mt-5 rounded-[18px] bg-[#f5f7f4] p-4">
              <div className="text-xs font-medium uppercase tracking-[0.08em] text-[#a0a3aa]">Your tenant ID</div>
              <div className="mt-1 font-mono text-sm text-[#4f5d54]">{org.tenantId}</div>
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
      <section className="rounded-[24px] border border-[#e0e4de] bg-white p-6 shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-[#087d50]">Approved enterprise</p>
        <h2 className="mt-2 text-4xl font-bold tracking-[-0.04em]">{org.name}</h2>
        <p className="mt-3 max-w-2xl leading-7 text-[#68746d]">Configure sandbox and production issuers so your runtime can verify exchange tokens.</p>
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
    <section className="rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
      <div className="border-b border-[#eceeeb] p-5">
        <h2 className="text-xl font-bold">Enterprise access</h2>
        <p className="mt-1 text-sm text-[#68746d]">Members and invite management will live here once WorkOS org membership is connected.</p>
      </div>
      <div className="p-5">
        <div className="rounded-[18px] bg-[#f5f7f4] p-5">
          <div className="text-sm text-[#68746d]">Current org</div>
          <div className="mt-1 text-lg font-bold">{org.name}</div>
          <span className="mt-4 inline-flex rounded-full border border-[#bdebd9] bg-[#e9f8f1] px-3 py-1 text-sm font-bold text-[#087d50]">Approved</span>
        </div>
      </div>
    </section>
  );
}

function InfoCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-[24px] border border-[#e0e4de] bg-white p-5 shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
      <div className="flex size-11 items-center justify-center rounded-[15px] bg-[#e9f8f1] text-[#087d50]">{icon}</div>
      <h3 className="mt-4 text-lg font-bold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-[#68746d]">{body}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[18px] bg-[#f5f7f4] p-4">
      <div className="text-sm text-[#68746d]">{label}</div>
      <div className="mt-1 font-mono text-lg font-bold">{value}</div>
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
    <section className="rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_10px_28px_-24px_rgba(20,21,27,0.42)]">
      <div className="border-b border-[#eceeeb] p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">{org ? "Enterprise org" : "Create enterprise org"}</h2>
            <p className="mt-1 text-sm leading-6 text-[#68746d]">
              This org owns the Tenant ID that is embedded in trusted exchange tokens.
            </p>
          </div>
          {org ? (
            <span className="rounded-full border border-[#bdebd9] bg-[#e9f8f1] px-3 py-1 text-sm font-semibold text-[#087d50]">Active</span>
          ) : null}
        </div>
      </div>
      <form
        className="space-y-4 p-5"
        onSubmit={event => {
          event.preventDefault();
          if (canSave) saveOrg.mutate();
        }}
      >
        <Field label="Organization name">
          <Input value={displayName} onChange={event => setDisplayName(event.target.value)} className="h-12 rounded-[12px] bg-white" placeholder="Acme Optical" />
        </Field>
        <Field label="Tenant ID">
          <Input
            value={tenantId}
            onChange={event => setTenantId(event.target.value.toLowerCase().replace(/\s+/g, ""))}
            className="h-12 rounded-[12px] bg-white font-mono"
            placeholder="acme"
            disabled={Boolean(org)}
          />
        </Field>
        <div className="rounded-[18px] bg-[#f5f7f4] p-4 text-sm leading-6 text-[#68746d]">
          <span className="font-semibold text-[#111318]">Issuer lookup:</span> your tokens must carry this id as the <span className="font-mono">tenantId</span> claim (plus an <span className="font-mono">env</span> claim) so the runtime can find the right issuer configuration.
        </div>
        {saveOrg.isError ? <ErrorText error={saveOrg.error} /> : null}
        <Button className="h-12 w-full rounded-full bg-[#111217] text-white hover:bg-[#25262c]" disabled={!canSave}>
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
    <section className="rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_10px_28px_-24px_rgba(20,21,27,0.42)]">
      <div className="border-b border-[#eceeeb] p-5">
        <div className="flex items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-[15px] bg-[#e9f8f1] text-[#087d50]">
            <Fingerprint className="size-5" />
          </div>
          <div>
            <h2 className="text-xl font-bold">{editing ? `Edit ${editing.environmentName} issuer` : "Add trusted issuer"}</h2>
            <p className="mt-1 text-sm leading-6 text-[#68746d]">Use exact HTTPS issuer URLs. Query strings and fragments are rejected.</p>
          </div>
        </div>
      </div>
      <form
        className="grid gap-4 p-5 md:grid-cols-2"
        onSubmit={event => {
          event.preventDefault();
          if (canSubmit) save.mutate();
        }}
      >
        <Field label="Environment">
          <Input value={environmentName} onChange={event => setEnvironmentName(event.target.value)} className="h-12 rounded-[12px] bg-white" placeholder="sandbox" disabled={disabled || Boolean(editing)} />
          {editing ? <p className="mt-1 text-xs leading-5 text-[#8a8d85]">Environment is the lookup key and can't be changed; remove and re-add to rename.</p> : null}
        </Field>
        <Field label="Issuer URL">
          <Input value={issuer} onChange={event => setIssuer(event.target.value)} className="h-12 rounded-[12px] bg-white font-mono" placeholder="https://auth.acme.com" disabled={disabled} />
        </Field>
        <div className="md:col-span-2">
          <Field label="JWKS URL">
            <div className="flex flex-wrap gap-2">
              <Input value={jwksUrl} onChange={event => { setJwksUrl(event.target.value); validate.reset(); }} className="h-12 min-w-[240px] flex-1 rounded-[12px] bg-white font-mono" placeholder="https://auth.acme.com/.well-known/jwks.json" disabled={disabled} />
              <Button
                type="button"
                variant="outline"
                className="h-12 rounded-[12px] px-4"
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
          <button type="button" className="text-sm font-semibold text-[#087d50]" onClick={() => setShowAdvanced(value => !value)}>
            {showAdvanced ? "Hide advanced" : "Advanced — subject claim"}
          </button>
          {showAdvanced ? (
            <div className="mt-3">
              <Field label="Subject claim">
                <Input value={subjectClaim} onChange={event => setSubjectClaim(event.target.value)} className="h-12 rounded-[12px] bg-white font-mono" placeholder="sub" disabled={disabled} />
                <p className="mt-1 text-xs leading-5 text-[#8a8d85]">Which claim holds the user id. Defaults to <span className="font-mono">sub</span> — only change it if your IdP puts the id elsewhere.</p>
              </Field>
            </div>
          ) : null}
        </div>

        <div className="md:col-span-2">
          {save.isError ? <ErrorText error={save.error} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button className="h-11 rounded-full bg-[#111217] px-5 text-white hover:bg-[#25262c]" disabled={!canSubmit}>
              <Plus className="size-4" />
              {editing ? (save.isPending ? "Saving..." : "Update issuer") : (save.isPending ? "Adding..." : "Add issuer")}
            </Button>
            {editing ? (
              <Button type="button" variant="outline" className="h-11 rounded-full px-5" onClick={reset}>Cancel</Button>
            ) : null}
          </div>
        </div>
      </form>
    </section>
  );
}

function JwksResult({ result, error }: { result?: JwksValidation; error: unknown }) {
  if (error) return <p className="mt-2 text-sm text-[#a64235]">{error instanceof Error ? error.message : "Validation failed"}</p>;
  if (!result) return null;
  if (!result.reachable || result.error) {
    return <p className="mt-2 text-sm font-medium text-[#a64235]">✕ {result.error ?? "Unreachable"}</p>;
  }
  return (
    <p className="mt-2 text-sm font-medium text-[#087d50]">
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
    <section className="rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
      <div className="flex items-center justify-between gap-4 border-b border-[#eceeeb] p-5">
        <div>
          <h2 className="text-xl font-bold">Trusted issuers</h2>
          <p className="mt-1 text-sm text-[#68746d]">Each environment maps one issuer URL to one JWKS endpoint.</p>
        </div>
        <span className="rounded-full border border-[#dfe3dc] bg-[#f6f7f5] px-3 py-1 text-sm font-semibold text-[#68746d]">{issuers.length} total</span>
      </div>
      {loading ? (
        <div className="p-5"><InlineLoading label="Loading issuers" /></div>
      ) : issuers.length === 0 ? (
        <div className="flex min-h-[220px] flex-col items-center justify-center p-6 text-center">
          <Fingerprint className="size-10 text-[#087d50]" />
          <h3 className="mt-4 text-lg font-bold">No issuers yet</h3>
          <p className="mt-2 max-w-md text-sm leading-6 text-[#747780]">Register the sandbox or production issuer your auth backend signs with. Tokens route by <span className="font-mono">tenantId</span> + <span className="font-mono">env</span>; the issuer URL is validated against the token's <span className="font-mono">iss</span>.</p>
        </div>
      ) : (
        <div className="divide-y divide-[#eceeeb]">
          {issuers.map(issuer => (
            <div key={issuer.id} className="grid gap-4 p-5 md:grid-cols-[150px_1fr_auto] md:items-center">
              <div>
                <div className="text-sm font-bold">{issuer.environmentName}</div>
                <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${issuer.enabled ? "bg-[#e9f8f1] text-[#087d50]" : "bg-[#fff3f1] text-[#a64235]"}`}>
                  {issuer.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <div className="min-w-0">
                <div className="truncate font-mono text-sm">{issuer.issuer}</div>
                <div className="mt-1 truncate font-mono text-xs text-[#747780]">{issuer.jwksUrl}</div>
                {issuer.updatedAt ? (
                  <div className="mt-1 truncate text-xs text-[#a0a3aa]">
                    Updated {formatDate(issuer.updatedAt)}{issuer.updatedBy ? ` · ${issuer.updatedBy}` : ""}
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" className="h-10 rounded-full px-4" onClick={() => onEdit(issuer)}>Edit</Button>
                <Button
                  variant="outline"
                  className="h-10 rounded-full px-4"
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate({ id: issuer.id, enabled: !issuer.enabled })}
                >
                  {issuer.enabled ? <ToggleRight className="size-5 text-[#087d50]" /> : <ToggleLeft className="size-5" />}
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
    <section className="rounded-[24px] bg-[#111318] p-5 text-white shadow-[0_18px_42px_-22px_rgba(20,21,27,0.55)]">
      <div className="flex items-center gap-3">
        <Globe2 className="size-5 text-[#57d391]" />
        <h2 className="text-xl font-bold">Token exchange contract</h2>
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-white/60">
        These are the claims your exchange token must carry. We route on <span className="font-mono text-white/80">tenantId</span> + <span className="font-mono text-white/80">env</span> to find your issuer config; <span className="font-mono text-white/80">iss</span> stays a real URL and is validated against what you registered.
      </p>
      <div className="mt-4 grid gap-2 rounded-[18px] bg-black/30 p-4 font-mono text-sm leading-7 text-[#d9f8e7] sm:grid-cols-2">
        <div><span className="text-white/45">tenantId</span> = {org?.tenantId ?? "create-org-first"}</div>
        <div><span className="text-white/45">env</span> = sandbox | prod | ...</div>
        <div><span className="text-white/45">iss</span> = trusted issuer URL (pinned)</div>
        <div><span className="text-white/45">aud</span> = cloud-runtime</div>
        <div><span className="text-white/45">sub</span> = your user id (or subjectClaim)</div>
      </div>
    </section>
  );
}

function LoginGate() {
  const loginUrl = `/api/console/auth/login?return_to=${encodeURIComponent(`${window.location.origin}/`)}`;

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[linear-gradient(180deg,#ffffff_0%,#f4f8f6_100%)] px-5 py-10 text-[#14141a]">
      <div className="pointer-events-none absolute left-[42%] top-[-54%] size-[980px] rounded-full bg-[radial-gradient(circle,rgba(201,244,232,0.78)_0%,rgba(228,246,240,0.46)_35%,rgba(255,255,255,0)_70%)] blur-[68px]" />
      <div className="pointer-events-none absolute left-[-24%] top-[58%] size-[720px] rounded-full bg-[radial-gradient(circle,rgba(214,242,235,0.68)_0%,rgba(232,247,242,0.4)_42%,rgba(255,255,255,0)_72%)] blur-[62px]" />

      <section className="relative flex w-full flex-col items-center justify-center gap-5">
        <div className="relative w-full max-w-[440px] overflow-hidden rounded-[24px] p-9 shadow-[0_16px_40px_-8px_rgba(20,20,26,0.07),0_0_0_1px_rgba(20,20,26,0.07),inset_0_1px_0_rgba(255,255,255,0.9)]">
          <div className="absolute inset-0 rounded-[24px] bg-[rgba(255,255,255,0.82)] backdrop-blur-[14px]" />
          <div className="relative text-center">
            <img src={mentraLogo} alt="Mentra" className="mx-auto h-[27px] w-[50px]" />

            <div className="h-[22px]" />
            <div className="mx-auto flex h-11 w-fit items-center gap-2 rounded-full bg-[#f0faf5] px-4 text-[12px] font-bold uppercase tracking-[0.14em] text-[#087d50] shadow-[0_0_0_1px_rgba(8,125,80,0.12)]">
              <Building2 className="size-4" />
              Enterprise
            </div>

            <div className="h-[18px]" />
            <h1 className="font-display text-[28px] font-bold leading-[32px] tracking-[-0.64px] text-[#14141a]">
              Sign into Mentra Enterprise Portal
            </h1>

            <div className="h-2.5" />
            <p className="mx-auto max-w-[320px] font-body text-[13.5px] leading-[20px] text-[#7a7a82]">
              Manage OEM auth issuers and token exchange configuration for runtime deployments.
            </p>

            <div className="h-8" />
            <a
              className="flex h-[48px] w-full items-center justify-center rounded-full bg-[#14141a] px-[18px] font-display text-sm font-semibold text-white shadow-[0_18px_44px_-10px_rgba(20,20,26,0.25),inset_0_1px_0_rgba(255,255,255,0.14)] transition hover:bg-[#24242b] focus:outline-none focus:ring-4 focus:ring-[#14141a]/10"
              href={loginUrl}
            >
              Continue with Mentra login
            </a>

            <div className="h-5" />
            <p className="font-body text-[11.5px] leading-4 text-[#a6a6ac]">
              Enterprise access controls which issuers can mint exchange tokens.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

function Splash({ label }: { label: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f7f4] text-[#68746d]">
      <Loader2 className="mr-3 size-5 animate-spin" />
      {label}
    </main>
  );
}

function InlineLoading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-[#68746d]">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Label className="block">
      <span className="mb-2 block text-sm font-semibold">{label}</span>
      {children}
    </Label>
  );
}

function ErrorText({ error }: { error: unknown }) {
  return (
    <div className="mb-3 rounded-[14px] bg-[#fff3f1] px-4 py-3 text-sm text-[#a64235]">
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

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    let message = `Request failed with ${response.status}`;
    try {
      const body = await response.json() as { error_description?: string; error?: string };
      message = body.error_description || body.error || message;
    } catch {
      // Keep generic status text.
    }
    throw new Error(message);
  }
  return await response.json() as T;
}

function suggestedOrgName(email: string): string {
  const domain = email.split("@")[1]?.split(".")[0];
  return domain ? `${domain[0].toUpperCase()}${domain.slice(1)} Enterprise` : "Acme Enterprise";
}

function suggestedTenantId(email: string): string {
  return (email.split("@")[1]?.split(".")[0] ?? "acme").toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

export default App;
