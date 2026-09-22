import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { AlertCircle, Bug, Check, ClipboardList, FileText, History, Home, Loader2, MessageSquareWarning, RefreshCcw, ShieldCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import mentraLogo from "./assets/mentra-logo.svg";

type Environment = "debug" | "dev" | "staging" | "prod";
interface AdminUser {
  developerId: string;
  email: string;
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
  const [deepLinkReportId, setDeepLinkReportId] = useState<string | null>(pendingDeepLinkReportId);
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
  if (me.isLoading) return <Splash label="Checking admin session" />;
  if (me.isError) {
    // A 403 means the Mentra login itself worked but the account isn't on the
    // admin allowlist; offering the login button again would be misleading.
    return <LoginGate denied={me.error instanceof ApiError && me.error.status === 403} />;
  }

  return (
    <AppShell
      brandTitle="Core admin"
      brandSubtitle="MentraOS"
      badge={<EnvBadge env={ENVIRONMENT} />}
      nav={[{key: "incidents", label: "Incident system", icon: Bug}]}
      activeKey="incidents"
      onSelect={() => setDeepLinkReportId(null)}
      title="Incident system"
      description="Bug reports and feedback filed from the Mentra App, with their screenshots and log bundles."
      userEmail={me.data?.user?.email ?? "Admin"}
      accountLabel="Admin"
      onSignOut={signOut}
      signingOut={signingOut}
    >
      <ReportsPage key={deepLinkReportId ?? "reports"} initialReportId={deepLinkReportId} />
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
                : "Investigate reports and manage Core operations."}
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
