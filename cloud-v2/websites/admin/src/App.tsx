import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Bug, Check, ClipboardList, CloudUpload, Loader2, PackageCheck, Rocket, ShieldCheck, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import mentraLogo from "./assets/mentra-logo.svg";

type Environment = "debug" | "dev" | "staging" | "prod";
type InstallPolicy = "install_once" | "keep_updated" | "mandatory";
type AdminPageKey = "preinstalled" | "review" | "incidents";
type ReleaseStatus = "draft" | "submitted" | "in_review" | "accepted" | "rejected" | "published" | "suspended";

interface AdminUser {
  developerId: string;
  email: string;
}

interface Registry {
  id: string;
  name: string;
  environment: Environment;
  status: string;
  activeRevisionId: string | null;
}

interface ReleaseSummary {
  id: string;
  packageName: string;
  displayName: string;
  version: string;
  status: ReleaseStatus;
  bundleSha256: string | null;
  reviewNotes?: string | null;
  submittedAt?: string | null;
  reviewedAt?: string | null;
  publishedAt?: string | null;
}

interface RegistryRevision {
  id: string;
  status: string;
  entries: Array<{
    releaseId: string;
    installPolicy: InstallPolicy;
    required: boolean;
  }>;
  createdAt: string | null;
  promotedAt: string | null;
}

interface AuditEvent {
  id: string;
  adminId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string | null;
  createdAt: string | null;
}

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
      <AdminPage />
    </QueryClientProvider>
  );
}

function AdminPage() {
  const qc = useQueryClient();
  const [page, setPage] = useState<AdminPageKey>("preinstalled");
  const [environment, setEnvironment] = useState<Environment>("dev");
  const [selectedReleaseIds, setSelectedReleaseIds] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);

  const me = useQuery({
    queryKey: ["admin-me"],
    queryFn: () => api<{ authenticated: true; admin: true; user: AdminUser | null }>("/api/admin/me"),
    retry: false,
  });
  const submissions = useQuery({
    queryKey: ["admin-submissions"],
    queryFn: () => api<{ submissions: ReleaseSummary[] }>("/api/admin/submissions"),
    enabled: me.isSuccess,
  });
  const registries = useQuery({
    queryKey: ["admin-registries"],
    queryFn: () => api<{ registries: Registry[] }>("/api/admin/preinstalled/registries"),
    enabled: me.isSuccess,
  });
  const releases = useQuery({
    queryKey: ["admin-releases"],
    queryFn: () => api<{ releases: ReleaseSummary[] }>("/api/admin/preinstalled/releases"),
    enabled: me.isSuccess,
  });
  const audit = useQuery({
    queryKey: ["admin-audit"],
    queryFn: () => api<{ events: AuditEvent[] }>("/api/admin/audit-log"),
    enabled: me.isSuccess,
  });
  const activeRegistry = useMemo(
    () => registries.data?.registries.find(registry => registry.environment === environment && registry.name === "default"),
    [environment, registries.data?.registries],
  );
  const revisions = useQuery({
    queryKey: ["admin-revisions", activeRegistry?.id],
    queryFn: () => api<{ revisions: RegistryRevision[] }>(`/api/admin/preinstalled/registries/${activeRegistry?.id}/revisions`),
    enabled: Boolean(activeRegistry?.id),
  });

  const reviewMutation = useMutation({
    mutationFn: (input: { releaseId: string; action: "approve" | "reject" | "publish" }) =>
      api<{ release: ReleaseSummary }>(`/api/admin/submissions/${input.releaseId}/${input.action}`, {
        method: "POST",
        body: { notes: `Admin ${input.action}` },
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["admin-submissions"] }),
        qc.invalidateQueries({ queryKey: ["admin-releases"] }),
        qc.invalidateQueries({ queryKey: ["admin-audit"] }),
      ]);
    },
  });

  const publishRegistry = useMutation({
    mutationFn: async () => {
      const registry = await api<{ registry: Registry }>("/api/admin/preinstalled/registries", {
        method: "POST",
        body: { environment },
      });
      const revision = await api<{ revision: RegistryRevision }>(
        `/api/admin/preinstalled/registries/${registry.registry.id}/revisions`,
        {
          method: "POST",
          body: {
            reason: `Admin preinstall registry publish for ${environment}`,
            entries: [...selectedReleaseIds].map((releaseId, index) => ({
              releaseId,
              required: false,
              installPolicy: "keep_updated" satisfies InstallPolicy,
              priority: index,
            })),
          },
        },
      );
      return api<{ registry: Registry; revision: RegistryRevision }>(
        `/api/admin/preinstalled/registries/${registry.registry.id}/revisions/${revision.revision.id}/promote`,
        { method: "POST" },
      );
    },
    onSuccess: async data => {
      setMessage(`Published ${data.revision.entries.length} release(s) to ${environment}.`);
      setSelectedReleaseIds(new Set());
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["admin-registries"] }),
        qc.invalidateQueries({ queryKey: ["admin-revisions"] }),
        qc.invalidateQueries({ queryKey: ["admin-audit"] }),
      ]);
    },
  });

  const selectedReleases = releases.data?.releases.filter(release => selectedReleaseIds.has(release.id)) ?? [];
  const pageMeta = {
    preinstalled: {
      title: "Preinstalled miniapps",
      eyebrow: "Managed default set",
      body: "Control the miniapps that MentraOS installs and keeps updated without requiring a mobile app release.",
    },
    review: {
      title: "Miniapp review",
      eyebrow: "Store publishing",
      body: "Review developer-submitted releases before they are published to the miniapp store.",
    },
    incidents: {
      title: "Incident system",
      eyebrow: "Support operations",
      body: "Review user reports, logs, and release incidents from the admin console.",
    },
  }[page];

  if (me.isLoading) return <Splash label="Checking admin session" />;
  if (me.isError) return <LoginGate />;

  return (
    <main className="h-dvh overflow-hidden bg-[#f5f6f4] text-[#14151b]">
      <AdminSidebar userEmail={me.data?.user?.email ?? "Admin"} page={page} setPage={setPage} />

      <section className="h-dvh overflow-y-auto overflow-x-hidden overscroll-contain sm:pl-[260px] lg:pl-[300px]">
        <header className="sticky top-0 z-10 border-b border-black/10 bg-white/88 px-5 py-5 backdrop-blur">
          <div className="mx-auto max-w-6xl">
            <div className="text-[13px] font-semibold uppercase tracking-[0.16em] text-[#087d50]">{pageMeta.eyebrow}</div>
            <div className="mt-1 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="font-display text-[30px] font-bold leading-9 tracking-[-0.04em]">{pageMeta.title}</h1>
                <p className="mt-1 max-w-2xl text-[#68746d]">{pageMeta.body}</p>
              </div>
              {page === "preinstalled" ? (
                <div className="rounded-full border border-[#dfe3dc] bg-white px-4 py-2 text-sm font-semibold text-[#4f5d54]">
                  {selectedReleases.length} selected
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <div className="mx-auto max-w-6xl px-5 py-6">
          {page === "preinstalled" ? (
            <PreinstalledPage
              environment={environment}
              setEnvironment={setEnvironment}
              releases={releases.data?.releases ?? []}
              loading={releases.isLoading}
              selectedReleaseIds={selectedReleaseIds}
              setSelectedReleaseIds={setSelectedReleaseIds}
              onPublish={() => publishRegistry.mutate()}
              publishing={publishRegistry.isPending}
              error={publishRegistry.error}
              message={message}
              activeRegistry={activeRegistry}
              revisions={revisions.data?.revisions ?? []}
              selectedReleases={selectedReleases}
              auditEvents={audit.data?.events ?? []}
            />
          ) : null}

          {page === "review" ? (
            <ReviewQueue
              submissions={submissions.data?.submissions ?? []}
              loading={submissions.isLoading}
              pending={reviewMutation.isPending}
              onAction={(releaseId, action) => reviewMutation.mutate({ releaseId, action })}
            />
          ) : null}

          {page === "incidents" ? <IncidentTodo /> : null}
        </div>
      </section>
    </main>
  );
}

function AdminSidebar(props: { userEmail: string; page: AdminPageKey; setPage: (page: AdminPageKey) => void }) {
  const navItems: Array<{ key: AdminPageKey; label: string; icon: React.ReactNode }> = [
    { key: "preinstalled", label: "Preinstalled miniapps", icon: <PackageCheck className="size-5" /> },
    { key: "review", label: "Miniapp review", icon: <ClipboardList className="size-5" /> },
    { key: "incidents", label: "Incident system", icon: <Bug className="size-5" /> },
  ];

  return (
    <aside className="border-b border-black/10 bg-white px-5 py-5 sm:fixed sm:inset-y-0 sm:left-0 sm:z-20 sm:flex sm:w-[260px] sm:flex-col sm:border-b-0 sm:border-r lg:w-[300px]">
      <div className="flex items-center gap-3">
        <div className="flex size-12 items-center justify-center rounded-[16px] border border-[#dfe5de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
          <img src={mentraLogo} alt="Mentra" className="h-[27px] w-[50px]" />
        </div>
        <div>
          <div className="text-xl font-bold leading-6 tracking-[-0.03em]">Admin</div>
          <div className="text-sm text-[#747780]">MentraOS</div>
        </div>
      </div>

      <nav className="mt-8 grid gap-2 sm:flex-1">
        {navItems.map(item => {
          const selected = props.page === item.key;
          return (
            <button
              key={item.key}
              className={`flex h-10 items-center gap-3 rounded-[10px] px-3 text-left text-[15px] font-medium transition ${
                selected ? "bg-[#111217] text-white" : "text-[#5d6068] hover:bg-[#f3f4f2] hover:text-[#111217]"
              }`}
              onClick={() => props.setPage(item.key)}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="mt-8 rounded-[18px] bg-[#f5f7f4] p-4 text-sm leading-6 text-[#68746d] sm:absolute sm:bottom-5 sm:left-5 sm:right-5">
        <div className="font-semibold text-[#111318]">Signed in</div>
        <div className="truncate">{props.userEmail}</div>
      </div>
    </aside>
  );
}

function PreinstalledPage(props: {
  environment: Environment;
  setEnvironment: (value: Environment) => void;
  releases: ReleaseSummary[];
  loading: boolean;
  selectedReleaseIds: Set<string>;
  setSelectedReleaseIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  onPublish: () => void;
  publishing: boolean;
  error: unknown;
  message: string | null;
  activeRegistry?: Registry;
  revisions: RegistryRevision[];
  selectedReleases: ReleaseSummary[];
  auditEvents: AuditEvent[];
}) {
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
      <section className="space-y-6">
        <RegistryPublisher
          environment={props.environment}
          setEnvironment={props.setEnvironment}
          releases={props.releases}
          loading={props.loading}
          selectedReleaseIds={props.selectedReleaseIds}
          setSelectedReleaseIds={props.setSelectedReleaseIds}
          onPublish={props.onPublish}
          publishing={props.publishing}
          error={props.error}
          message={props.message}
        />
      </section>

      <aside className="space-y-6">
        <section className="rounded-[24px] bg-[#111318] p-5 text-white shadow-[0_18px_42px_-22px_rgba(20,21,27,0.55)]">
          <Rocket className="mb-4 size-7 text-[#57d391]" />
          <h2 className="text-xl font-bold">Active preinstall list</h2>
          <p className="mt-2 text-sm leading-6 text-white/65">
            {props.activeRegistry?.activeRevisionId
              ? `${envLabel(props.environment)} has an active list.`
              : `No active ${envLabel(props.environment)} list yet.`}
          </p>
          <div className="mt-4 rounded-[18px] bg-white/8 p-4 text-sm">
            <div className="flex justify-between"><span className="text-white/50">Selected now</span><span>{props.selectedReleases.length}</span></div>
            <div className="mt-2 flex justify-between"><span className="text-white/50">Update mode</span><span>Managed</span></div>
          </div>
        </section>

        <section className="rounded-[24px] border border-[#e0e4de] bg-white p-5 shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
          <h2 className="text-xl font-bold">Recent publishes</h2>
          <div className="mt-4 space-y-3">
            {props.revisions.length > 0 ? props.revisions.slice(0, 4).map(revision => (
              <div key={revision.id} className="rounded-[16px] bg-[#f5f7f4] p-4">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{revision.entries.length} miniapp(s)</span>
                  <span className="rounded-full bg-white px-3 py-1 text-xs uppercase tracking-[0.12em] text-[#68746d]">{revision.status}</span>
                </div>
                <p className="mt-2 text-xs text-[#68746d]">{revision.promotedAt ?? revision.createdAt ?? "No date"}</p>
              </div>
            )) : <p className="text-sm text-[#68746d]">No publishes yet.</p>}
          </div>
        </section>

        <section className="rounded-[24px] border border-[#e0e4de] bg-white p-5 shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
          <h2 className="text-xl font-bold">Audit log</h2>
          <div className="mt-4 space-y-3">
            {props.auditEvents.length > 0 ? props.auditEvents.slice(0, 6).map(event => (
              <div key={event.id} className="rounded-[16px] bg-[#f5f7f4] p-4">
                <div className="font-mono text-xs text-[#087d50]">{event.action}</div>
                <div className="mt-1 truncate text-sm font-semibold">{event.targetType}:{event.targetId}</div>
                <div className="mt-1 text-xs text-[#747780]">{event.createdAt ?? "No date"}</div>
              </div>
            )) : <p className="text-sm text-[#68746d]">No audit events yet.</p>}
          </div>
        </section>
      </aside>
    </div>
  );
}

function ReviewQueue(props: {
  submissions: ReleaseSummary[];
  loading: boolean;
  pending: boolean;
  onAction: (releaseId: string, action: "approve" | "reject" | "publish") => void;
}) {
  const queue = props.submissions.filter(release => release.status !== "draft");
  return (
    <section className="rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
      <div className="flex items-center justify-between gap-4 border-b border-[#eceeeb] p-5">
        <div>
          <h2 className="text-xl font-bold">Submitted releases</h2>
          <p className="mt-1 text-sm text-[#68746d]">Normal developer releases are reviewed here before store publishing. Preinstalled miniapps are managed separately.</p>
        </div>
        <ClipboardList className="size-5 text-[#087d50]" />
      </div>
      {props.loading ? (
        <div className="p-5"><InlineLoading label="Loading submissions" /></div>
      ) : queue.length === 0 ? (
        <EmptyState title="No submissions" body="Developer releases appear here after they are submitted for review." />
      ) : (
        <div className="divide-y divide-[#eceeeb]">
          {queue.map(release => (
            <div key={release.id} className="grid gap-4 p-5 md:grid-cols-[1fr_auto] md:items-center">
              <ReleaseIdentity release={release} />
              <div className="flex flex-wrap gap-2">
                {["submitted", "in_review", "rejected"].includes(release.status) ? (
                  <Button className="rounded-full bg-[#e9f8f1] text-[#087d50] hover:bg-[#dff5eb]" disabled={props.pending} onClick={() => props.onAction(release.id, "approve")}>
                    <Check className="size-4" /> Approve
                  </Button>
                ) : null}
                {["submitted", "in_review", "accepted"].includes(release.status) ? (
                  <Button className="rounded-full bg-[#fff3f1] text-[#a64235] hover:bg-[#ffe7e2]" disabled={props.pending} onClick={() => props.onAction(release.id, "reject")}>
                    <X className="size-4" /> Reject
                  </Button>
                ) : null}
                {release.status === "accepted" ? (
                  <Button className="rounded-full bg-[#111217] text-white hover:bg-[#25262c]" disabled={props.pending} onClick={() => props.onAction(release.id, "publish")}>
                    Publish
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RegistryPublisher(props: {
  environment: Environment;
  setEnvironment: (value: Environment) => void;
  releases: ReleaseSummary[];
  loading: boolean;
  selectedReleaseIds: Set<string>;
  setSelectedReleaseIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  onPublish: () => void;
  publishing: boolean;
  error: unknown;
  message: string | null;
}) {
  return (
    <section className="rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#eceeeb] p-5">
        <div>
          <h2 className="text-xl font-bold">Preinstalled miniapp list</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-[#68746d]">
            This list is fetched by mobile clients so we can add or update default miniapps without shipping a new iOS or Android build.
          </p>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Target environment">
          {(["debug", "dev", "staging", "prod"] as Environment[]).map(environment => (
            <button
              key={environment}
              className={`rounded-full px-4 py-2 text-sm font-bold transition ${
                props.environment === environment
                  ? "bg-[#111318] text-white"
                  : "border border-[#dfe3dc] bg-[#f6f7f5] text-[#4f5d54] hover:bg-white"
              }`}
              onClick={() => props.setEnvironment(environment)}
            >
              {envLabel(environment)}
            </button>
          ))}
        </div>
      </div>

      <div className="p-5">
        <div className="mb-4 rounded-[18px] bg-[#f5f7f4] p-4 text-sm leading-6 text-[#68746d]">
          <span className="font-semibold text-[#111318]">{envLabel(props.environment)} target:</span> selected releases become the managed default set for this environment. Existing users can receive updates through the mobile registry sync.
        </div>
        <div className="space-y-3">
          {props.loading ? (
            <InlineLoading label="Loading approved releases" />
          ) : props.releases.length === 0 ? (
            <EmptyState title="No publishable releases" body="Publish a miniapp release from review before adding it to the preinstalled list." />
          ) : props.releases.map(release => (
            <button
              key={release.id}
              className={`flex w-full items-center gap-4 rounded-[18px] border p-4 text-left ${props.selectedReleaseIds.has(release.id) ? "border-[#1bbd7e] bg-[#effaf5]" : "border-[#e0e4de] bg-white"}`}
              onClick={() =>
                props.setSelectedReleaseIds(current => {
                  const next = new Set(current);
                  if (next.has(release.id)) next.delete(release.id);
                  else next.add(release.id);
                  return next;
                })
              }
            >
              <span className={`flex size-10 items-center justify-center rounded-[14px] ${props.selectedReleaseIds.has(release.id) ? "bg-[#1bbd7e] text-white" : "bg-[#e9f8f1] text-[#087d50]"}`}>
                {props.selectedReleaseIds.has(release.id) ? <Check className="size-4" /> : <PackageCheck className="size-4" />}
              </span>
              <ReleaseIdentity release={release} compact />
            </button>
          ))}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#eceeeb] pt-5">
          <p className="max-w-xl text-sm leading-6 text-[#68746d]">
            Publishing replaces the active preinstalled miniapp list for {envLabel(props.environment)}.
          </p>
          <Button className="h-12 rounded-full bg-[#111217] px-6 text-white hover:bg-[#25262c]" disabled={props.selectedReleaseIds.size === 0 || props.publishing} onClick={props.onPublish}>
            {props.publishing ? <Loader2 className="size-4 animate-spin" /> : <CloudUpload className="size-4" />}
            Publish preinstalled list
          </Button>
          {props.error ? <ErrorText error={props.error} /> : null}
          {props.message ? <p className="mt-3 rounded-[14px] bg-[#e9f8f1] p-3 text-sm text-[#087d50]">{props.message}</p> : null}
        </div>
      </div>
    </section>
  );
}

function ReleaseIdentity({ release, compact = false }: { release: ReleaseSummary; compact?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <div className={`${compact ? "text-sm" : "text-base"} truncate font-bold`}>{release.displayName}</div>
      <div className="mt-1 truncate font-mono text-xs text-[#68746d]">{release.packageName}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        <span className="rounded-full bg-[#f0f2ef] px-2.5 py-1 font-mono text-xs">{release.version}</span>
        <span className="rounded-full bg-[#f0f2ef] px-2.5 py-1 text-xs uppercase tracking-[0.1em]">{release.status.replace("_", " ")}</span>
      </div>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-[190px] flex-col items-center justify-center p-6 text-center">
      <AlertCircle className="size-8 text-[#879088]" />
      <h3 className="mt-4 text-lg font-bold">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-6 text-[#68746d]">{body}</p>
    </div>
  );
}

function IncidentTodo() {
  return (
    <section className="rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
      <div className="border-b border-[#eceeeb] p-5">
        <div className="flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-[16px] bg-[#e9f8f1] text-[#087d50]">
            <Bug className="size-6" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Incident system</h2>
            <p className="mt-1 text-sm text-[#68746d]">Placeholder for migrating user reports, logs, triage state, and incident review into this admin console.</p>
          </div>
        </div>
      </div>
      <div className="grid gap-4 p-5 md:grid-cols-3">
        {[
          ["Reports", "Browse submitted user feedback and linked logs."],
          ["Triage", "Assign status, owner, severity, and release impact."],
          ["Review", "Connect incidents back to miniapp releases and app versions."],
        ].map(([title, body]) => (
          <div key={title} className="rounded-[18px] bg-[#f5f7f4] p-5">
            <div className="text-lg font-bold">{title}</div>
            <p className="mt-2 text-sm leading-6 text-[#68746d]">{body}</p>
            <span className="mt-4 inline-flex rounded-full border border-[#dfe3dc] bg-white px-3 py-1 text-xs font-bold uppercase tracking-[0.12em] text-[#68746d]">
              WIP
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function envLabel(environment: Environment): string {
  return {
    debug: "Debug",
    dev: "Dev",
    staging: "Staging",
    prod: "Prod",
  }[environment];
}

function LoginGate() {
  const loginUrl = `/api/console/auth/login?return_to=${encodeURIComponent(`${window.location.origin}/`)}`;

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[linear-gradient(180deg,#ffffff_0%,#f4f8f6_100%)] px-5 py-10 text-[#14141a]">
      <div className="pointer-events-none absolute left-[42%] top-[-54%] size-[980px] rounded-full bg-[radial-gradient(circle,rgba(201,244,232,0.78)_0%,rgba(228,246,240,0.46)_35%,rgba(255,255,255,0)_70%)] blur-[68px]" />
      <div className="pointer-events-none absolute left-[-24%] top-[58%] size-[720px] rounded-full bg-[radial-gradient(circle,rgba(214,242,235,0.68)_0%,rgba(232,247,242,0.4)_42%,rgba(255,255,255,0)_72%)] blur-[62px]" />

      <section className="relative flex w-full flex-col items-center justify-center gap-5">
        <div className="relative w-full max-w-[420px] overflow-hidden rounded-[24px] p-9 shadow-[0_16px_40px_-8px_rgba(20,20,26,0.07),0_0_0_1px_rgba(20,20,26,0.07),inset_0_1px_0_rgba(255,255,255,0.9)]">
          <div className="absolute inset-0 rounded-[24px] bg-[rgba(255,255,255,0.82)] backdrop-blur-[14px]" />
          <div className="relative text-center">
            <img src={mentraLogo} alt="Mentra" className="mx-auto h-[27px] w-[50px]" />

            <div className="h-[22px]" />
            <div className="mx-auto flex h-11 w-fit items-center gap-2 rounded-full bg-[#f0faf5] px-4 text-[12px] font-bold uppercase tracking-[0.14em] text-[#087d50] shadow-[0_0_0_1px_rgba(8,125,80,0.12)]">
              <ShieldCheck className="size-4" />
              Internal admin
            </div>

            <div className="h-[18px]" />
            <h1 className="font-display text-[26px] font-bold leading-[30px] tracking-[-0.52px] text-[#14141a]">
              Sign into Mentra Admin
            </h1>

            <div className="h-2.5" />
            <p className="mx-auto max-w-[300px] font-body text-[13.5px] leading-[20px] text-[#7a7a82]">
              Review miniapp releases, publish preinstalled registries, and manage internal operations.
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
              Admin access is limited to configured internal accounts.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

function Splash(props: { label: string }) {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f5f7f4]">
      <div className="flex items-center gap-3 rounded-full bg-white px-5 py-3 shadow-sm ring-1 ring-black/10">
        <Loader2 className="size-5 animate-spin text-[#038755]" />
        <span>{props.label}</span>
      </div>
    </main>
  );
}

function InlineLoading(props: { label: string }) {
  return (
    <div className="flex items-center gap-3 rounded-[18px] bg-[#f5f7f4] px-5 py-4 text-[#68746d]">
      <Loader2 className="size-5 animate-spin" />
      {props.label}
    </div>
  );
}

function ErrorText({ error }: { error: unknown }) {
  return (
    <p className="mt-3 rounded-[14px] bg-[#fff3f1] p-3 text-sm text-[#a64235]">
      {error instanceof Error ? error.message : "Request failed"}
    </p>
  );
}

async function api<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: opts?.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(opts?.body ? { "content-type": "application/json" } : {}),
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json() as { error_description?: string; message?: string };
      detail = body.error_description ?? body.message ?? detail;
    } catch {
      // keep status detail
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export default App;
