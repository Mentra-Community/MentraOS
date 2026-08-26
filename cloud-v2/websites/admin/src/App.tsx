import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Bug, Check, ClipboardList, CloudUpload, FileText, History, Home, Loader2, MessageSquareWarning, PackageCheck, RefreshCcw, RotateCcw, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AppShell, type NavItem } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import mentraLogo from "./assets/mentra-logo.svg";

type Environment = "debug" | "dev" | "staging" | "prod";
type InstallPolicy = "install_once" | "keep_updated" | "mandatory";
type AdminPageKey = "home" | "review" | "preinstalled" | "audit" | "incidents";
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
  description?: string | null;
  version: string;
  releaseTrack: "stable" | "beta";
  status: ReleaseStatus;
  bundleSha256: string | null;
  bundleSizeBytes?: number | null;
  manifestSha256?: string | null;
  manifest?: Record<string, unknown> | null;
  signingKeyId?: string | null;
  signedAt?: string | null;
  storeListing?: {
    subtitle: string | null;
    longDescription: string | null;
    categories: string[];
    privacyPolicyUrl: string | null;
    supportUrl: string | null;
    websiteUrl: string | null;
    reviewTier: "community" | "verified";
    featured: boolean;
    iconAssetId: string | null;
    coverAssetId: string | null;
    screenshotAssetIds: string[];
  };
  storeAssets?: Array<{
    id: string;
    role: "store_icon" | "store_cover" | "gallery_screenshot";
    fileName: string;
    contentType: string;
    sizeBytes: number;
  }>;
  listingReadiness?: { ready: boolean; missing: string[] };
  reviewNotes?: string | null;
  submittedAt?: string | null;
  reviewedAt?: string | null;
  publishedAt?: string | null;
  publicStoreApprovedAt?: string | null;
  isActiveRelease?: boolean;
  requiresPublicStoreApproval?: boolean;
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

type ReportKind = "bug" | "feedback" | "automatic";
type ReportStatus = "collecting" | "ready" | "closed";

interface ReportArtifact {
  artifactId: string;
  type: "logs" | "screenshot" | "state_snapshot";
  source: string;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  createdAt: string | null;
}

interface ReportSummary {
  reportId: string;
  kind: ReportKind;
  status: ReportStatus;
  mentraUserId: string;
  trigger: {
    type: string;
    source: string;
    reason: string;
    sourceAppletPackageName?: string;
    sourceAppletName?: string;
  } | null;
  report: ({ actualBehavior?: string; expectedBehavior?: string; userSeverity?: number; contactEmail?: string } & Record<string, unknown>) | null;
  feedback: Record<string, unknown> | null;
  artifacts: ReportArtifact[];
  createdAt: string | null;
  updatedAt: string | null;
}

interface ReportDetailResponse {
  report: ReportSummary & { context: Record<string, unknown> };
  assets: Array<{
    artifactId: string;
    fileName: string | null;
    contentType: string;
    sizeBytes: number;
    sha256: string;
  }>;
}

interface ReportLogEntry {
  timestamp: number;
  level: string;
  message: string;
  source?: string;
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

const ADMIN_NAV: readonly NavItem[] = [
  { key: "home", label: "Home", icon: Home },
  { key: "review", label: "Miniapp review", icon: ClipboardList },
  { key: "preinstalled", label: "Preinstalled miniapps", icon: PackageCheck },
  { key: "audit", label: "Audit log", icon: History },
  { key: "incidents", label: "Incident system", icon: Bug },
];

/**
 * The admin environment is bound to the hostname, not chosen in-app (PRD: no
 * env switcher; opening the matching hostname switches environment). Localhost
 * and anything unrecognized default to dev so local development is harmless.
 */
function detectEnvironment(): Environment {
  const host = window.location.hostname;
  if (host === "admin.mentraglass.com") return "prod";
  if (host.startsWith("admin.staging.")) return "staging";
  if (host.startsWith("admin.dev.")) return "dev";
  return "dev";
}
const ENVIRONMENT = detectEnvironment();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AdminPage />
    </QueryClientProvider>
  );
}

// Deep link used by report Slack notifications: /?report=rep_… lands on the
// Incident system page with that report open. AdminPage captures the id into
// state and clears the URL only once the session is confirmed — while logged
// out the param must stay in the address bar so LoginGate's return_to brings
// it back through the auth round-trip. Navigating between pages spends it.
let pendingDeepLinkReportId = new URLSearchParams(window.location.search).get("report");

function AdminPage() {
  const qc = useQueryClient();
  const env = ENVIRONMENT;
  const [page, setPage] = useState<AdminPageKey>(pendingDeepLinkReportId ? "incidents" : "home");
  const [deepLinkReportId, setDeepLinkReportId] = useState<string | null>(pendingDeepLinkReportId);
  const [selectedReleaseIds, setSelectedReleaseIds] = useState<Set<string>>(new Set());
  const [detailReleaseId, setDetailReleaseId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/console/auth/logout", { method: "POST", headers: { accept: "application/json" } });
    } catch {
      // best-effort; reload still drops us at the login gate
    }
    window.location.reload();
  }

  const me = useQuery({
    queryKey: ["admin-me"],
    queryFn: () => api<{ authenticated: true; admin: true; user: AdminUser | null }>("/api/admin/me"),
    retry: false,
  });

  useEffect(() => {
    // The deep link is safe in state now, so drop it from the address bar —
    // but only once signed in; before that, LoginGate's return_to still needs
    // the parameter to survive the auth round-trip. Idempotent on re-runs.
    if (me.isSuccess && pendingDeepLinkReportId) {
      pendingDeepLinkReportId = null;
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [me.isSuccess]);
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
    () => registries.data?.registries.find(registry => registry.environment === env && registry.name === "default"),
    [env, registries.data?.registries],
  );
  const revisions = useQuery({
    queryKey: ["admin-revisions", activeRegistry?.id],
    queryFn: () => api<{ revisions: RegistryRevision[] }>(`/api/admin/preinstalled/registries/${activeRegistry?.id}/revisions`),
    enabled: Boolean(activeRegistry?.id),
  });

  // Review decisions carry the reviewer's typed notes. "Request changes" is a
  // reject with feedback the developer sees; the backend has no separate verb.
  const reviewMutation = useMutation({
    mutationFn: (input: { releaseId: string; action: "approve" | "reject" | "publish"; notes: string }) =>
      api<{ release: ReleaseSummary }>(`/api/admin/submissions/${input.releaseId}/${input.action}`, {
        method: "POST",
        body: { notes: input.notes },
      }),
    onSuccess: async () => {
      setDetailReleaseId(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["admin-submissions"] }),
        qc.invalidateQueries({ queryKey: ["admin-releases"] }),
        qc.invalidateQueries({ queryKey: ["admin-audit"] }),
      ]);
    },
  });
  const moderationMutation = useMutation({
    mutationFn: (input: { packageName: string; reviewTier: "community" | "verified"; featured: boolean }) =>
      api(`/api/admin/apps/${encodeURIComponent(input.packageName)}/store-moderation`, {
        method: "PATCH",
        body: { reviewTier: input.reviewTier, featured: input.featured },
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["admin-submissions"] }),
        qc.invalidateQueries({ queryKey: ["admin-audit"] }),
      ]);
    },
  });

  const publishRegistry = useMutation({
    mutationFn: async () => {
      const registry = await api<{ registry: Registry }>("/api/admin/preinstalled/registries", {
        method: "POST",
        body: { environment: env },
      });
      const revision = await api<{ revision: RegistryRevision }>(
        `/api/admin/preinstalled/registries/${registry.registry.id}/revisions`,
        {
          method: "POST",
          body: {
            reason: `Admin preinstall registry publish for ${env}`,
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
      setMessage(`Published ${data.revision.entries.length} release(s) to ${envLabel(env)}.`);
      setSelectedReleaseIds(new Set());
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["admin-registries"] }),
        qc.invalidateQueries({ queryKey: ["admin-revisions"] }),
        qc.invalidateQueries({ queryKey: ["admin-audit"] }),
      ]);
    },
  });

  // Restore (rollback): re-promote a previous revision. Same promote endpoint.
  const restoreRevision = useMutation({
    mutationFn: (revisionId: string) =>
      api(`/api/admin/preinstalled/registries/${activeRegistry?.id}/revisions/${revisionId}/promote`, { method: "POST" }),
    onSuccess: async () => {
      setMessage(`Restored a previous preinstall revision for ${envLabel(env)}.`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["admin-registries"] }),
        qc.invalidateQueries({ queryKey: ["admin-revisions"] }),
        qc.invalidateQueries({ queryKey: ["admin-audit"] }),
      ]);
    },
  });

  const submissionList = submissions.data?.submissions ?? [];
  const releaseList = releases.data?.releases ?? [];
  const revisionList = revisions.data?.revisions ?? [];
  const auditEvents = audit.data?.events ?? [];
  const pendingReviews = submissionList.filter(release =>
    ["submitted", "in_review"].includes(release.status) || needsPublicApproval(release),
  );
  const selectedReleases = releaseList.filter(release => selectedReleaseIds.has(release.id));
  const detailRelease = [...submissionList, ...releaseList].find(release => release.id === detailReleaseId) ?? null;

  const pageMeta: Record<AdminPageKey, { title: string; body: string }> = {
    home: { title: "Operations home", body: "Pending review, the active preinstall list, and recent admin actions." },
    review: { title: "Miniapp review", body: "Review developer-submitted releases before they are published to the store." },
    preinstalled: { title: "Preinstalled miniapps", body: "The managed default set MentraOS installs and keeps updated without a mobile app release." },
    audit: { title: "Audit log", body: "Every admin mutation: who approved, rejected, published, or promoted something." },
    incidents: { title: "Incident system", body: "Bug reports and feedback filed from the Mentra App, with their screenshots and log bundles." },
  };

  if (me.isLoading) return <Splash label="Checking admin session" />;
  if (me.isError) {
    // A 403 means the Mentra login itself worked but the account isn't on the
    // admin allowlist; offering the login button again would be misleading.
    return <LoginGate denied={me.error instanceof ApiError && me.error.status === 403} />;
  }

  return (
    <AppShell
      brandTitle="Admin"
      brandSubtitle="MentraOS"
      badge={<EnvBadge env={env} />}
      nav={ADMIN_NAV}
      activeKey={page}
      onSelect={key => {
        setPage(key as AdminPageKey);
        // Any navigation spends the deep link: coming back to the Incident
        // system page starts unselected.
        setDeepLinkReportId(null);
      }}
      title={pageMeta[page].title}
      description={pageMeta[page].body}
      userEmail={me.data?.user?.email ?? "Admin"}
      accountLabel="Admin"
      onSignOut={signOut}
      signingOut={signingOut}
      headerAction={
        page === "preinstalled" && selectedReleases.length > 0 ? (
          <div className="rounded-full border border-[#dfe3dc] bg-white px-4 py-2 text-sm font-semibold text-[#4f5d54]">
            {selectedReleases.length} selected
          </div>
        ) : undefined
      }
    >
      {page === "home" ? (
        <HomePage
          env={env}
          loading={submissions.isLoading || registries.isLoading}
          pendingReviews={pendingReviews}
          activeRegistry={activeRegistry}
          activeRevision={revisionList.find(rev => rev.id === activeRegistry?.activeRevisionId)}
          auditEvents={auditEvents}
          onOpenRelease={setDetailReleaseId}
          onGo={setPage}
        />
      ) : null}

      {page === "review" ? (
        <ReviewQueue
          submissions={submissionList}
          loading={submissions.isLoading}
          onOpen={setDetailReleaseId}
        />
      ) : null}

      {page === "preinstalled" ? (
        <PreinstalledPage
          env={env}
          releases={releaseList}
          loading={releases.isLoading}
          selectedReleaseIds={selectedReleaseIds}
          setSelectedReleaseIds={setSelectedReleaseIds}
          onPublish={() => publishRegistry.mutate()}
          publishing={publishRegistry.isPending}
          error={publishRegistry.error}
          message={message}
          activeRegistry={activeRegistry}
          revisions={revisionList}
          onRestore={id => restoreRevision.mutate(id)}
          restoring={restoreRevision.isPending}
        />
      ) : null}

      {page === "audit" ? <AuditPage events={auditEvents} loading={audit.isLoading} /> : null}

      {page === "incidents" ? <ReportsPage initialReportId={deepLinkReportId} /> : null}

      {detailRelease ? (
        <SubmissionDetail
          release={detailRelease}
          history={submissionList.filter(r => r.packageName === detailRelease.packageName)}
          pending={reviewMutation.isPending || moderationMutation.isPending}
          error={reviewMutation.error ?? moderationMutation.error}
          onClose={() => setDetailReleaseId(null)}
          onAction={(action, notes) => reviewMutation.mutate({ releaseId: detailRelease.id, action, notes })}
          onModerate={(reviewTier, featured) =>
            moderationMutation.mutate({ packageName: detailRelease.packageName, reviewTier, featured })
          }
        />
      ) : null}
    </AppShell>
  );
}

function EnvBadge({ env }: { env: Environment }) {
  const danger = env === "prod";
  return (
    <div className="space-y-2">
      <div className="flex h-9 items-center gap-2 rounded-[10px] border border-[#dceee4] bg-[#f0faf5] px-3 text-xs font-semibold uppercase tracking-[0.1em] text-[#087d50]">
        <ShieldCheck className="size-4 shrink-0" />
        Internal admin
      </div>
      <div
        className={`flex h-9 items-center justify-between gap-2 rounded-[10px] border px-3 text-xs font-semibold uppercase tracking-[0.1em] ${
          danger
            ? "border-[#f0d2cc] bg-[#fff3f1] text-[#a64235]"
            : "border-[#dfe3dc] bg-[#f6f7f5] text-[#4f5d54]"
        }`}
        title="Environment is bound to the hostname and cannot be changed here."
      >
        <span>Env · {envLabel(env)}</span>
        <span className="text-[10px] font-medium normal-case opacity-70">read-only</span>
      </div>
    </div>
  );
}

function HomePage(props: {
  env: Environment;
  loading: boolean;
  pendingReviews: ReleaseSummary[];
  activeRegistry?: Registry;
  activeRevision?: RegistryRevision;
  auditEvents: AuditEvent[];
  onOpenRelease: (id: string) => void;
  onGo: (page: AdminPageKey) => void;
}) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Pending reviews"
          value={String(props.pendingReviews.length)}
          hint="Releases awaiting a decision"
          tone={props.pendingReviews.length > 0 ? "alert" : "calm"}
          onClick={() => props.onGo("review")}
        />
        <StatCard
          label={`Preinstall · ${envLabel(props.env)}`}
          value={props.activeRegistry?.activeRevisionId ? `${props.activeRevision?.entries.length ?? 0} apps` : "None"}
          hint={props.activeRegistry?.activeRevisionId ? "Active managed default set" : "No active list yet"}
          tone="calm"
          onClick={() => props.onGo("preinstalled")}
        />
        <StatCard
          label="Recent admin actions"
          value={String(props.auditEvents.length)}
          hint="In the audit log"
          tone="calm"
          onClick={() => props.onGo("audit")}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <section className="rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
          <div className="flex items-center justify-between gap-4 border-b border-[#eceeeb] p-5">
            <h2 className="text-xl font-bold">Review queue</h2>
            <Button variant="ghost" className="rounded-full text-[#087d50] hover:bg-[#eef8f2]" onClick={() => props.onGo("review")}>
              Open queue
            </Button>
          </div>
          {props.loading ? (
            <div className="p-5"><InlineLoading label="Loading queue" /></div>
          ) : props.pendingReviews.length === 0 ? (
            <EmptyState title="Queue is clear" body="No releases are waiting for review right now." />
          ) : (
            <div className="divide-y divide-[#eceeeb]">
              {props.pendingReviews.slice(0, 5).map(release => (
                <button
                  key={release.id}
                  className="flex w-full items-center gap-4 p-5 text-left hover:bg-[#fafbfa]"
                  onClick={() => props.onOpenRelease(release.id)}
                >
                  <ReleaseIdentity release={release} compact />
                  <span className="shrink-0 text-sm font-semibold text-[#087d50]">Review →</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-[24px] border border-[#e0e4de] bg-white p-5 shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
          <h2 className="text-xl font-bold">Recent actions</h2>
          <div className="mt-4 space-y-3">
            {props.auditEvents.length > 0 ? props.auditEvents.slice(0, 6).map(event => (
              <AuditRow key={event.id} event={event} compact />
            )) : <p className="text-sm text-[#68746d]">No admin actions yet.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard(props: { label: string; value: string; hint: string; tone: "alert" | "calm"; onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      className="rounded-[20px] border border-[#e0e4de] bg-white p-5 text-left shadow-[0_1px_2px_rgba(20,21,27,0.06)] transition hover:border-[#cfe6da] hover:shadow-[0_8px_24px_-18px_rgba(20,21,27,0.4)]"
    >
      <div className="text-xs font-medium uppercase tracking-[0.1em] text-[#a0a3aa]">{props.label}</div>
      <div className={`mt-2 text-3xl font-bold tracking-[-0.02em] ${props.tone === "alert" ? "text-[#a64235]" : "text-[#14151b]"}`}>{props.value}</div>
      <div className="mt-1 text-sm text-[#747780]">{props.hint}</div>
    </button>
  );
}

function ReviewQueue(props: { submissions: ReleaseSummary[]; loading: boolean; onOpen: (id: string) => void }) {
  const queue = props.submissions.filter(release => release.status !== "draft");
  return (
    <section className="rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
      <div className="flex items-center justify-between gap-4 border-b border-[#eceeeb] p-5">
        <div>
          <h2 className="text-xl font-bold">Submitted releases</h2>
          <p className="mt-1 text-sm text-[#68746d]">Open a release to inspect its metadata and approve, request changes, or publish.</p>
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
            <button key={release.id} className="flex w-full items-center gap-4 p-5 text-left hover:bg-[#fafbfa]" onClick={() => props.onOpen(release.id)}>
              <ReleaseIdentity release={release} />
              <span className="shrink-0 text-sm font-semibold text-[#087d50]">Open →</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function SubmissionDetail(props: {
  release: ReleaseSummary;
  history: ReleaseSummary[];
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onAction: (action: "approve" | "reject" | "publish", notes: string) => void;
  onModerate: (reviewTier: "community" | "verified", featured: boolean) => void;
}) {
  const { release } = props;
  const [notes, setNotes] = useState("");
  const priorHistory = props.history.filter(r => r.id !== release.id);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[#111217]/30" onClick={props.onClose}>
      <div
        className="h-full w-full max-w-[560px] overflow-y-auto bg-[#f7f8f6] shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[#e4e6e2] bg-white/90 px-6 py-4 backdrop-blur">
          <h2 className="font-display text-lg font-bold">Release review</h2>
          <Button variant="ghost" size="icon" className="rounded-full" onClick={props.onClose} aria-label="Close">
            <X className="size-5" />
          </Button>
        </div>

        <div className="space-y-5 p-6">
          <div className="rounded-[18px] border border-[#e0e4de] bg-white p-5">
            <div className="text-lg font-bold">{release.displayName}</div>
            <div className="mt-1 font-mono text-sm text-[#68746d]">{release.packageName}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Tag>{release.version}</Tag>
              <StatusTag status={release.status} />
              {needsPublicApproval(release) ? <Tag>public review pending</Tag> : null}
            </div>
          </div>

          <DetailGrid
            rows={[
              ["Bundle SHA-256", release.bundleSha256 ? `${release.bundleSha256.slice(0, 16)}…` : "—"],
              ["Release track", release.releaseTrack],
              ["Bundle size", formatBytes(release.bundleSizeBytes)],
              ["Manifest SHA-256", release.manifestSha256 ? `${release.manifestSha256.slice(0, 16)}…` : "—"],
              ["Signing key", release.signingKeyId ?? "—"],
              ["Signed", formatDate(release.signedAt)],
              ["Submitted", formatDate(release.submittedAt)],
              ["Reviewed", formatDate(release.reviewedAt)],
              ["Published", formatDate(release.publishedAt)],
              ["Public Store approval", formatDate(release.publicStoreApprovedAt)],
            ]}
          />

          <ManifestReview manifest={release.manifest} />
          <StoreListingReview
            release={release}
            pending={props.pending}
            onModerate={props.onModerate}
          />

          {release.reviewNotes ? (
            <div className="rounded-[18px] border border-[#e0e4de] bg-white p-5">
              <div className="text-xs font-medium uppercase tracking-[0.1em] text-[#a0a3aa]">Last review notes</div>
              <p className="mt-2 text-sm leading-6 text-[#4f5d54]">{release.reviewNotes}</p>
            </div>
          ) : null}

          {priorHistory.length > 0 ? (
            <div className="rounded-[18px] border border-[#e0e4de] bg-white p-5">
              <div className="text-xs font-medium uppercase tracking-[0.1em] text-[#a0a3aa]">Prior releases for this package</div>
              <div className="mt-3 space-y-2">
                {priorHistory.map(prior => (
                  <div key={prior.id} className="flex items-center justify-between text-sm">
                    <span className="font-mono text-[#4f5d54]">{prior.version}</span>
                    <StatusTag status={prior.status} small />
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="rounded-[18px] border border-[#e0e4de] bg-white p-5">
            <label className="text-xs font-medium uppercase tracking-[0.1em] text-[#a0a3aa]">Review notes (shared with developer on reject / request changes)</label>
            <textarea
              value={notes}
              onChange={event => setNotes(event.target.value)}
              rows={3}
              placeholder="Optional for approve / publish. Required when requesting changes."
              className="mt-2 w-full rounded-[12px] border border-[#e0e4de] bg-white p-3 text-sm outline-none focus:border-[#1bbd7e] focus:ring-2 focus:ring-[#1bbd7e]/20"
            />
            {props.error ? <ErrorText error={props.error} /> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {["submitted", "in_review"].includes(release.status) || needsPublicApproval(release) ? (
                <Button
                  className="rounded-full bg-[#e9f8f1] text-[#087d50] hover:bg-[#dff5eb]"
                  disabled={props.pending}
                  onClick={() => props.onAction("approve", notes.trim() || "Approved for the public Store")}
                >
                  <Check className="size-4" /> {needsPublicApproval(release) ? "Approve for public Store" : "Approve"}
                </Button>
              ) : null}
              {["submitted", "in_review", "accepted"].includes(release.status) ? (
                <Button
                  className="rounded-full bg-[#fff7df] text-[#a66a00] hover:bg-[#fff0c4]"
                  disabled={props.pending || notes.trim().length === 0}
                  onClick={() => props.onAction("reject", notes.trim())}
                  title={notes.trim().length === 0 ? "Add notes explaining what to change" : undefined}
                >
                  <MessageSquareWarning className="size-4" /> Request changes
                </Button>
              ) : null}
              {["submitted", "in_review", "accepted"].includes(release.status) ? (
                <Button
                  className="rounded-full bg-[#fff3f1] text-[#a64235] hover:bg-[#ffe7e2]"
                  disabled={props.pending}
                  onClick={() => props.onAction("reject", notes.trim() || "Rejected")}
                >
                  <X className="size-4" /> Reject
                </Button>
              ) : null}
              {release.status === "accepted" ? (
                <Button
                  className="rounded-full bg-[#111217] text-white hover:bg-[#25262c]"
                  disabled={props.pending || release.listingReadiness?.ready === false}
                  onClick={() => props.onAction("publish", notes.trim() || "Published")}
                >
                  Publish to store
                </Button>
              ) : null}
              {release.listingReadiness?.ready === false ? (
                <p className="w-full text-xs text-[#a64235]">
                  Publishing blocked until the developer adds: {release.listingReadiness.missing.join(", ")}.
                </p>
              ) : null}
              {props.pending ? <Loader2 className="size-5 animate-spin self-center text-[#68746d]" /> : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ManifestReview({ manifest }: { manifest?: Record<string, unknown> | null }) {
  if (!manifest) {
    return (
      <div className="rounded-[18px] border border-[#f0d2cc] bg-[#fff7f5] p-5 text-sm text-[#a64235]">
        Canonical manifest is unavailable for this release.
      </div>
    );
  }
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  const hardware = Array.isArray(manifest.hardwareRequirements) ? manifest.hardwareRequirements : [];
  return (
    <div className="rounded-[18px] border border-[#e0e4de] bg-white p-5">
      <div className="text-xs font-medium uppercase tracking-[0.1em] text-[#a0a3aa]">Canonical manifest</div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <ManifestList title="Permissions" values={permissions} empty="No permissions declared" />
        <ManifestList title="Hardware requirements" values={hardware} empty="No hardware requirements" />
      </div>
      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold text-[#087d50]">View complete signed manifest</summary>
        <pre className="mt-3 max-h-[320px] overflow-auto rounded-[12px] bg-[#151816] p-4 text-xs leading-5 text-[#dce5de]">
          {JSON.stringify(manifest, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function ManifestList({ title, values, empty }: { title: string; values: unknown[]; empty: string }) {
  return (
    <div>
      <div className="text-sm font-semibold text-[#1c1d22]">{title}</div>
      {values.length > 0 ? (
        <div className="mt-2 space-y-2">
          {values.map((value, index) => (
            <div key={index} className="rounded-[10px] bg-[#f5f7f4] px-3 py-2 font-mono text-xs text-[#4f5d54]">
              {typeof value === "string" ? value : JSON.stringify(value)}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm text-[#879088]">{empty}</p>
      )}
    </div>
  );
}

function StoreListingReview(props: {
  release: ReleaseSummary;
  pending: boolean;
  onModerate: (reviewTier: "community" | "verified", featured: boolean) => void;
}) {
  const listing = props.release.storeListing;
  if (!listing) return null;
  const assets = props.release.storeAssets ?? [];
  return (
    <div className="rounded-[18px] border border-[#e0e4de] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-[0.1em] text-[#a0a3aa]">Store listing</div>
          <div className="mt-1 text-sm font-semibold text-[#1c1d22]">{listing.subtitle || "No subtitle"}</div>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
          props.release.listingReadiness?.ready ? "bg-[#e9f8f1] text-[#087d50]" : "bg-[#fff3f1] text-[#a64235]"
        }`}>
          {props.release.listingReadiness?.ready ? "Ready" : "Incomplete"}
        </span>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[#4f5d54]">
        {listing.longDescription || props.release.description || "No description provided."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {listing.categories.map(category => <Tag key={category}>{category}</Tag>)}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {assets.map(asset => (
          <figure key={asset.id} className="overflow-hidden rounded-[12px] border border-[#e0e4de] bg-[#f5f7f4]">
            <img
              src={`/api/admin/apps/${encodeURIComponent(props.release.packageName)}/store-assets/${encodeURIComponent(asset.id)}`}
              alt={asset.role.replaceAll("_", " ")}
              className="aspect-square w-full object-cover"
            />
            <figcaption className="truncate px-2 py-1.5 text-[10px] text-[#68746d]">{asset.fileName}</figcaption>
          </figure>
        ))}
      </div>
      {assets.length === 0 ? <p className="mt-3 text-sm text-[#879088]">No Store artwork uploaded.</p> : null}
      <div className="mt-4 space-y-1 text-xs text-[#68746d]">
        <div>Privacy: {listing.privacyPolicyUrl || "missing"}</div>
        <div>Support: {listing.supportUrl || "missing"}</div>
        <div>Website: {listing.websiteUrl || "not provided"}</div>
      </div>
      {props.release.status !== "published" || props.release.isActiveRelease ? (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-[#eceeeb] pt-4">
          <Button
            variant="outline"
            className="rounded-full"
            disabled={props.pending}
            onClick={() =>
              props.onModerate(listing.reviewTier === "verified" ? "community" : "verified", listing.featured)
            }
          >
            {listing.reviewTier === "verified" ? "Set community" : "Mark verified"}
          </Button>
          <Button
            variant="outline"
            className="rounded-full"
            disabled={props.pending}
            onClick={() => props.onModerate(listing.reviewTier, !listing.featured)}
          >
            {listing.featured ? "Remove featured" : "Feature miniapp"}
          </Button>
        </div>
      ) : (
        <p className="mt-4 border-t border-[#eceeeb] pt-4 text-xs text-[#879088]">
          This historical publication is immutable. Moderate the active release instead.
        </p>
      )}
    </div>
  );
}

function PreinstalledPage(props: {
  env: Environment;
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
  onRestore: (revisionId: string) => void;
  restoring: boolean;
}) {
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
      <section className="space-y-6">
        <section className="rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#eceeeb] p-5">
            <div>
              <h2 className="text-xl font-bold">Preinstalled miniapp list</h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-[#68746d]">
                Mobile clients fetch this list, so we can add or update default miniapps without shipping a new iOS or Android build.
              </p>
            </div>
            <div className="flex h-9 items-center gap-2 rounded-full border border-[#dfe3dc] bg-[#f6f7f5] px-4 text-sm font-semibold text-[#4f5d54]">
              {envLabel(props.env)} environment
            </div>
          </div>

          <div className="p-5">
            <div className="mb-4 rounded-[18px] bg-[#f5f7f4] p-4 text-sm leading-6 text-[#68746d]">
              <span className="font-semibold text-[#111318]">Managed set:</span> selected releases become the default set for <span className="font-semibold">{envLabel(props.env)}</span>. Existing users receive updates through mobile registry sync.
            </div>
            <div className="space-y-3">
              {props.loading ? (
                <InlineLoading label="Loading approved releases" />
              ) : props.releases.length === 0 ? (
                <EmptyState title="No publishable releases" body="Publish a miniapp release from review before adding it to the preinstalled list." />
              ) : props.releases.map(release => {
                const selected = props.selectedReleaseIds.has(release.id);
                return (
                  <button
                    key={release.id}
                    className={`flex w-full items-center gap-4 rounded-[18px] border p-4 text-left ${selected ? "border-[#1bbd7e] bg-[#effaf5]" : "border-[#e0e4de] bg-white"}`}
                    onClick={() =>
                      props.setSelectedReleaseIds(current => {
                        const next = new Set(current);
                        if (next.has(release.id)) next.delete(release.id);
                        else next.add(release.id);
                        return next;
                      })
                    }
                  >
                    <span className={`flex size-10 items-center justify-center rounded-[14px] ${selected ? "bg-[#1bbd7e] text-white" : "bg-[#e9f8f1] text-[#087d50]"}`}>
                      {selected ? <Check className="size-4" /> : <PackageCheck className="size-4" />}
                    </span>
                    <ReleaseIdentity release={release} compact />
                  </button>
                );
              })}
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#eceeeb] pt-5">
              <p className="max-w-xl text-sm leading-6 text-[#68746d]">
                Publishing replaces the active preinstalled miniapp list for {envLabel(props.env)}.
              </p>
              <Button className="h-12 rounded-full bg-[#111217] px-6 text-white hover:bg-[#25262c]" disabled={props.selectedReleaseIds.size === 0 || props.publishing} onClick={props.onPublish}>
                {props.publishing ? <Loader2 className="size-4 animate-spin" /> : <CloudUpload className="size-4" />}
                Publish preinstalled list
              </Button>
            </div>
            {props.error ? <ErrorText error={props.error} /> : null}
            {props.message ? <p className="mt-3 rounded-[14px] bg-[#e9f8f1] p-3 text-sm text-[#087d50]">{props.message}</p> : null}
          </div>
        </section>
      </section>

      <aside className="space-y-6">
        <section className="rounded-[24px] bg-[#111318] p-5 text-white shadow-[0_18px_42px_-22px_rgba(20,21,27,0.55)]">
          <PackageCheck className="mb-4 size-7 text-[#57d391]" />
          <h2 className="text-xl font-bold">Active list</h2>
          <p className="mt-2 text-sm leading-6 text-white/65">
            {props.activeRegistry?.activeRevisionId ? `${envLabel(props.env)} has an active preinstall list.` : `No active ${envLabel(props.env)} list yet.`}
          </p>
        </section>

        <section className="rounded-[24px] border border-[#e0e4de] bg-white p-5 shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
          <h2 className="text-xl font-bold">Revision history</h2>
          <p className="mt-1 text-sm text-[#68746d]">Restore re-promotes a past revision as the live list.</p>
          <div className="mt-4 space-y-3">
            {props.revisions.length > 0 ? props.revisions.map(revision => {
              const active = revision.id === props.activeRegistry?.activeRevisionId;
              return (
                <div key={revision.id} className="rounded-[16px] bg-[#f5f7f4] p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{revision.entries.length} miniapp(s)</span>
                    {active ? (
                      <span className="rounded-full bg-[#e9f8f1] px-3 py-1 text-xs font-bold uppercase tracking-[0.1em] text-[#087d50]">Active</span>
                    ) : (
                      <span className="rounded-full bg-white px-3 py-1 text-xs uppercase tracking-[0.12em] text-[#68746d]">{revision.status}</span>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-[#68746d]">{formatDate(revision.promotedAt ?? revision.createdAt)}</p>
                  {!active ? (
                    <Button
                      variant="ghost"
                      className="mt-2 h-8 rounded-full px-3 text-xs text-[#4f5d54] hover:bg-white"
                      disabled={props.restoring}
                      onClick={() => props.onRestore(revision.id)}
                    >
                      <RotateCcw className="size-3.5" /> Restore
                    </Button>
                  ) : null}
                </div>
              );
            }) : <p className="text-sm text-[#68746d]">No publishes yet.</p>}
          </div>
        </section>
      </aside>
    </div>
  );
}

function AuditPage(props: { events: AuditEvent[]; loading: boolean }) {
  const [filter, setFilter] = useState("");
  const filtered = props.events.filter(event => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return [event.action, event.targetType, event.targetId, event.adminId, event.reason ?? ""].some(value => value.toLowerCase().includes(q));
  });
  return (
    <section className="rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#eceeeb] p-5">
        <div>
          <h2 className="text-xl font-bold">Audit log</h2>
          <p className="mt-1 text-sm text-[#68746d]">{props.events.length} recorded admin actions.</p>
        </div>
        <input
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder="Filter by action, target, admin…"
          className="h-10 w-full max-w-xs rounded-full border border-[#e0e4de] bg-[#f7f8f6] px-4 text-sm outline-none focus:border-[#1bbd7e] focus:bg-white sm:w-72"
        />
      </div>
      {props.loading ? (
        <div className="p-5"><InlineLoading label="Loading audit log" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState title="No matching events" body={props.events.length === 0 ? "Admin actions will be recorded here." : "Try a different filter."} />
      ) : (
        <div className="divide-y divide-[#eceeeb]">
          {filtered.map(event => <AuditRow key={event.id} event={event} />)}
        </div>
      )}
    </section>
  );
}

function AuditRow({ event, compact = false }: { event: AuditEvent; compact?: boolean }) {
  if (compact) {
    return (
      <div className="rounded-[16px] bg-[#f5f7f4] p-4">
        <div className="font-mono text-xs text-[#087d50]">{event.action}</div>
        <div className="mt-1 truncate text-sm font-semibold">{event.targetType}:{event.targetId}</div>
        <div className="mt-1 text-xs text-[#747780]">{formatDate(event.createdAt)}</div>
      </div>
    );
  }
  return (
    <div className="grid gap-2 p-5 md:grid-cols-[180px_1fr_180px] md:items-center">
      <span className="inline-flex w-fit rounded-full bg-[#eef8f2] px-3 py-1 font-mono text-xs font-semibold text-[#087d50]">{event.action}</span>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">{event.targetType}:{event.targetId}</div>
        {event.reason ? <div className="mt-0.5 truncate text-sm text-[#68746d]">{event.reason}</div> : null}
        <div className="mt-0.5 truncate text-xs text-[#a0a3aa]">by {event.adminId}</div>
      </div>
      <div className="text-sm text-[#747780] md:text-right">{formatDate(event.createdAt)}</div>
    </div>
  );
}

function ReportsPage({ initialReportId = null }: { initialReportId?: string | null }) {
  const [kind, setKind] = useState<"all" | ReportKind>("all");
  const [status, setStatus] = useState<"all" | ReportStatus>("all");
  const [detailId, setDetailId] = useState<string | null>(initialReportId);

  const reports = useQuery({
    queryKey: ["admin-reports", kind, status],
    queryFn: () => {
      const params = new URLSearchParams();
      if (kind !== "all") params.set("kind", kind);
      if (status !== "all") params.set("status", status);
      const qs = params.toString();
      return api<{ reports: ReportSummary[] }>(`/api/admin/reports${qs ? `?${qs}` : ""}`);
    },
  });
  const rows = reports.data?.reports ?? [];

  return (
    <div className="space-y-6">
      <section className="rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#eceeeb] p-5">
          <div>
            <h2 className="text-xl font-bold">User reports</h2>
            <p className="mt-1 text-sm text-[#68746d]">
              Everything filed through the Mentra App reporting flow — open a report for its context, screenshots, and logs.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FilterPills
              value={kind}
              onChange={setKind}
              options={[["all", "All kinds"], ["bug", "Bug"], ["feedback", "Feedback"], ["automatic", "Automatic"]]}
            />
            <FilterPills
              value={status}
              onChange={setStatus}
              options={[["all", "Any status"], ["collecting", "Collecting"], ["ready", "Ready"], ["closed", "Closed"]]}
            />
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              onClick={() => reports.refetch()}
              aria-label="Refresh reports"
              disabled={reports.isFetching}
            >
              <RefreshCcw className={`size-4 ${reports.isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
        {reports.isLoading ? (
          <div className="p-5"><InlineLoading label="Loading reports" /></div>
        ) : reports.isError ? (
          <div className="p-5"><ErrorText error={reports.error} /></div>
        ) : rows.length === 0 ? (
          <EmptyState title="No reports" body="Bug reports and feedback submitted from the Mentra App will appear here." />
        ) : (
          <div className="divide-y divide-[#eceeeb]">
            {rows.map(report => (
              <button
                key={report.reportId}
                className="flex w-full items-start gap-4 p-5 text-left hover:bg-[#fafbfa]"
                onClick={() => setDetailId(report.reportId)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <ReportKindTag kind={report.kind} />
                    <ReportStatusTag status={report.status} />
                    {report.artifacts.length > 0 ? (
                      <span className="rounded-full bg-[#f0f2ef] px-2.5 py-0.5 text-xs font-semibold text-[#4f5d54]">
                        {report.artifacts.length} artifact{report.artifacts.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-2 line-clamp-2 text-sm font-semibold leading-5">{reportSummaryText(report)}</div>
                  <div className="mt-1 truncate font-mono text-xs text-[#a0a3aa]">
                    {report.mentraUserId} · {report.trigger?.source ?? "—"}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm text-[#747780]">{formatDate(report.createdAt)}</div>
                  <div className="mt-1 text-sm font-semibold text-[#087d50]">Open →</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <p className="px-1 text-xs text-[#a0a3aa]">
        Triage (owner, severity, release impact) and release review are planned follow-ups for this page.
      </p>

      {detailId ? <ReportDetailDrawer reportId={detailId} onClose={() => setDetailId(null)} /> : null}
    </div>
  );
}

function FilterPills<T extends string>(props: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<readonly [T, string]>;
}) {
  return (
    <div className="flex h-9 items-center gap-1 rounded-full border border-[#e0e4de] bg-[#f7f8f6] p-1">
      {props.options.map(([value, label]) => (
        <button
          key={value}
          onClick={() => props.onChange(value)}
          className={`h-7 rounded-full px-3 text-xs font-semibold ${
            props.value === value ? "bg-white text-[#14151b] shadow-sm" : "text-[#68746d] hover:text-[#14151b]"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ReportDetailDrawer(props: { reportId: string; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ["admin-report", props.reportId],
    queryFn: () => api<ReportDetailResponse>(`/api/admin/reports/${props.reportId}`),
  });
  const report = detail.data?.report;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[#111217]/30" onClick={props.onClose}>
      <div
        className="h-full w-full max-w-[640px] overflow-y-auto bg-[#f7f8f6] shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[#e4e6e2] bg-white/90 px-6 py-4 backdrop-blur">
          <h2 className="font-display text-lg font-bold">Report</h2>
          <Button variant="ghost" size="icon" className="rounded-full" onClick={props.onClose} aria-label="Close">
            <X className="size-5" />
          </Button>
        </div>

        <div className="space-y-5 p-6">
          {detail.isLoading ? <InlineLoading label="Loading report" /> : null}
          {detail.isError ? <ErrorText error={detail.error} /> : null}
          {report ? (
            <>
              <div className="rounded-[18px] border border-[#e0e4de] bg-white p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <ReportKindTag kind={report.kind} />
                  <ReportStatusTag status={report.status} />
                </div>
                <div className="mt-3 font-mono text-xs text-[#68746d]">{report.reportId}</div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[#14151b]">{reportSummaryText(report)}</p>
                {report.report?.expectedBehavior ? (
                  <p className="mt-2 text-sm leading-6 text-[#68746d]">
                    <span className="font-semibold text-[#4f5d54]">Expected:</span> {report.report.expectedBehavior}
                  </p>
                ) : null}
              </div>

              <DetailGrid
                rows={[
                  ["User", report.mentraUserId],
                  ["Filed", formatDate(report.createdAt)],
                  ["Source", report.trigger?.source ?? "—"],
                  ["Reason", report.trigger?.reason ?? "—"],
                  ["Severity", report.report?.userSeverity != null ? `${report.report.userSeverity}/5` : "—"],
                  ["Contact", report.report?.contactEmail ?? "—"],
                  ["Applet", report.trigger?.sourceAppletName ?? report.trigger?.sourceAppletPackageName ?? "—"],
                  ["Updated", formatDate(report.updatedAt)],
                ]}
              />

              <div className="rounded-[18px] border border-[#e0e4de] bg-white p-5">
                <div className="text-xs font-medium uppercase tracking-[0.1em] text-[#a0a3aa]">
                  Artifacts ({report.artifacts.length})
                </div>
                {report.artifacts.length === 0 ? (
                  <p className="mt-2 text-sm text-[#68746d]">No screenshots or logs were attached.</p>
                ) : (
                  <div className="mt-3 space-y-4">
                    {report.artifacts.map(artifact => (
                      <ReportArtifactView key={artifact.artifactId} reportId={report.reportId} artifact={artifact} />
                    ))}
                  </div>
                )}
              </div>

              <details className="rounded-[18px] border border-[#e0e4de] bg-white p-5">
                <summary className="cursor-pointer text-xs font-medium uppercase tracking-[0.1em] text-[#a0a3aa]">
                  Device context
                </summary>
                <pre className="mt-3 max-h-96 overflow-auto rounded-[12px] bg-[#f5f7f4] p-4 font-mono text-xs leading-5 text-[#4f5d54]">
                  {JSON.stringify(report.context, null, 2)}
                </pre>
              </details>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Mirrors the admin API's INLINE_CONTENT_TYPES: anything outside this set is
// served as an opaque attachment, so an <img> preview would render broken —
// HEIC/HEIF iOS screenshots being the common case. Those fall through to the
// download link instead.
const PREVIEWABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function isPreviewableImage(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return PREVIEWABLE_IMAGE_TYPES.has(contentType.split(";")[0].trim().toLowerCase());
}

function ReportArtifactView({ reportId, artifact }: { reportId: string; artifact: ReportArtifact }) {
  const url = `/api/admin/reports/${reportId}/artifacts/${artifact.artifactId}`;
  const header = (
    <div className="flex flex-wrap items-center gap-2 text-xs text-[#68746d]">
      <span className="font-semibold uppercase tracking-[0.08em]">{artifact.type.replace("_", " ")}</span>
      <span>· {artifact.source}</span>
      {artifact.sizeBytes != null ? <span>· {formatBytes(artifact.sizeBytes)}</span> : null}
      {artifact.filename ? <span className="truncate font-mono">· {artifact.filename}</span> : null}
    </div>
  );

  if (artifact.type === "screenshot" && isPreviewableImage(artifact.contentType)) {
    return (
      <div className="rounded-[14px] bg-[#f5f7f4] p-3">
        {header}
        <a href={url} target="_blank" rel="noreferrer">
          <img
            src={url}
            alt={artifact.filename ?? "screenshot"}
            loading="lazy"
            className="mt-2 max-h-72 rounded-[10px] border border-[#e0e4de] bg-white"
          />
        </a>
      </div>
    );
  }
  if (artifact.type === "logs") {
    return (
      <div className="rounded-[14px] bg-[#f5f7f4] p-3">
        {header}
        <LogArtifactViewer url={url} />
      </div>
    );
  }
  return (
    <div className="rounded-[14px] bg-[#f5f7f4] p-3">
      {header}
      <a className="mt-2 inline-flex items-center gap-2 text-sm font-semibold text-[#087d50]" href={url} download>
        <FileText className="size-4" /> Download payload
      </a>
    </div>
  );
}

function LogArtifactViewer({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  const logs = useQuery({
    queryKey: ["admin-report-log", url],
    queryFn: () => api<{ entries: ReportLogEntry[] }>(url),
    enabled: open,
  });

  if (!open) {
    return (
      <Button variant="ghost" className="mt-2 h-8 rounded-full px-3 text-xs text-[#087d50] hover:bg-white" onClick={() => setOpen(true)}>
        <FileText className="size-3.5" /> View log entries
      </Button>
    );
  }
  if (logs.isLoading) return <div className="mt-2"><InlineLoading label="Loading log entries" /></div>;
  if (logs.isError) return <ErrorText error={logs.error} />;
  const entries = logs.data?.entries ?? [];
  return (
    <div className="mt-2 max-h-72 overflow-auto rounded-[10px] border border-[#e0e4de] bg-white p-3 font-mono text-xs leading-5">
      {entries.length === 0 ? (
        <span className="text-[#68746d]">Log bundle is empty.</span>
      ) : entries.map((entry, index) => (
        <div key={index} className="whitespace-pre-wrap">
          <span className="text-[#a0a3aa]">{new Date(entry.timestamp).toISOString()}</span>{" "}
          <span className={entry.level === "error" ? "font-semibold text-[#a64235]" : "text-[#087d50]"}>{entry.level}</span>{" "}
          {entry.source ? <span className="text-[#68746d]">[{entry.source}]</span> : null} {entry.message}
        </div>
      ))}
    </div>
  );
}

function ReportKindTag({ kind }: { kind: ReportKind }) {
  const tone: Record<ReportKind, string> = {
    bug: "bg-[#fff3f1] text-[#a64235]",
    feedback: "bg-[#eef2ff] text-[#3a55c8]",
    automatic: "bg-[#f0f2ef] text-[#68746d]",
  };
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.08em] ${tone[kind]}`}>{kind}</span>;
}

function ReportStatusTag({ status }: { status: ReportStatus }) {
  const tone: Record<ReportStatus, string> = {
    collecting: "bg-[#fff7df] text-[#a66a00]",
    ready: "bg-[#e9f8f1] text-[#087d50]",
    closed: "bg-[#111217] text-white",
  };
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-[0.08em] ${tone[status]}`}>{status}</span>;
}

function reportSummaryText(report: ReportSummary): string {
  if (report.report?.actualBehavior) return String(report.report.actualBehavior);
  if (report.feedback) {
    if (typeof report.feedback.message === "string" && report.feedback.message) return report.feedback.message;
    const text = JSON.stringify(report.feedback);
    if (text && text !== "{}") return text;
  }
  return report.trigger?.reason ?? "—";
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ReleaseIdentity({ release, compact = false }: { release: ReleaseSummary; compact?: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <div className={`${compact ? "text-sm" : "text-base"} truncate font-bold`}>{release.displayName}</div>
      <div className="mt-1 truncate font-mono text-xs text-[#68746d]">{release.packageName}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Tag>{release.version}</Tag>
        <Tag>{release.releaseTrack}</Tag>
        <StatusTag status={release.status} small />
      </div>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-[#f0f2ef] px-2.5 py-1 font-mono text-xs">{children}</span>;
}

function needsPublicApproval(release: ReleaseSummary): boolean {
  return release.requiresPublicStoreApproval === true;
}

function StatusTag({ status, small = false }: { status: ReleaseStatus; small?: boolean }) {
  const tone: Record<ReleaseStatus, string> = {
    draft: "bg-[#f0f2ef] text-[#68746d]",
    submitted: "bg-[#eef2ff] text-[#3a55c8]",
    in_review: "bg-[#fff7df] text-[#a66a00]",
    accepted: "bg-[#e9f8f1] text-[#087d50]",
    published: "bg-[#111217] text-white",
    rejected: "bg-[#fff3f1] text-[#a64235]",
    suspended: "bg-[#fff3f1] text-[#a64235]",
  };
  return (
    <span className={`rounded-full px-2.5 ${small ? "py-0.5" : "py-1"} text-xs font-semibold uppercase tracking-[0.08em] ${tone[status]}`}>
      {status.replace("_", " ")}
    </span>
  );
}

function DetailGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="grid gap-px overflow-hidden rounded-[18px] border border-[#e0e4de] bg-[#e0e4de] sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="bg-white p-4">
          <div className="text-xs font-medium uppercase tracking-[0.1em] text-[#a0a3aa]">{label}</div>
          <div className="mt-1 truncate font-mono text-sm text-[#4f5d54]">{value}</div>
        </div>
      ))}
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

function envLabel(environment: Environment): string {
  return { debug: "Debug", dev: "Dev", staging: "Staging", prod: "Prod" }[environment];
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function LoginGate({ denied = false }: { denied?: boolean }) {
  // The full URL (not just the origin) so a /?report=… deep link survives the
  // login round-trip; safeReturnTo on Core validates the origin either way.
  const loginUrl = `/api/console/auth/login?return_to=${encodeURIComponent(window.location.href)}`;

  async function signOutAndReload() {
    try {
      await fetch("/api/console/auth/logout", { method: "POST", headers: { accept: "application/json" } });
    } catch {
      // best-effort; the reload lands back on this gate either way
    }
    window.location.reload();
  }

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
              {denied ? "No admin access" : "Sign into Mentra Admin"}
            </h1>

            <div className="h-2.5" />
            <p className="mx-auto max-w-[300px] font-body text-[13.5px] leading-[20px] text-[#7a7a82]">
              {denied
                ? "You're signed in, but this account isn't on the admin allowlist. Switch accounts, or ask for your email to be added to the Core admin allowlist."
                : "Review miniapp releases, publish preinstalled registries, and manage internal operations."}
            </p>

            <div className="h-8" />
            {denied ? (
              <button
                type="button"
                className="flex h-[48px] w-full items-center justify-center rounded-full bg-[#14141a] px-[18px] font-display text-sm font-semibold text-white shadow-[0_18px_44px_-10px_rgba(20,20,26,0.25),inset_0_1px_0_rgba(255,255,255,0.14)] transition hover:bg-[#24242b] focus:outline-none focus:ring-4 focus:ring-[#14141a]/10"
                onClick={signOutAndReload}
              >
                Sign out and switch account
              </button>
            ) : (
              <a
                className="flex h-[48px] w-full items-center justify-center rounded-full bg-[#14141a] px-[18px] font-display text-sm font-semibold text-white shadow-[0_18px_44px_-10px_rgba(20,20,26,0.25),inset_0_1px_0_rgba(255,255,255,0.14)] transition hover:bg-[#24242b] focus:outline-none focus:ring-4 focus:ring-[#14141a]/10"
                href={loginUrl}
              >
                Continue with Mentra login
              </a>
            )}

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

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
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
    throw new ApiError(detail, res.status);
  }
  return res.json() as Promise<T>;
}

export default App;
