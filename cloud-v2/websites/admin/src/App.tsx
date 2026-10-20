import {LoadingIndicator} from "./components/loading-indicator";
import {PrRoutineCheckPage, readPrCheckId} from './pages/pr-routine-check';
import {TestRunsTabs} from "./pages/test-runs-tabs";
import {TestRerunPage, readRerunId} from "./pages/test-reruns";
import {TestSuitePage, readSuiteId} from "./pages/test-suites";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, BarChart3, BookOpen, Bug, FileText, FlaskConical, History, KeyRound, RefreshCcw, ShieldCheck, Ticket, Users, X } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell, type NavItem } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import mentraLogo from "./assets/mentra-logo.svg";
import { resolvePage, visiblePages, type AdminMe, type AdminPageKey } from "./lib/admin-access";
import { api, ApiError } from "./lib/api";
import { FleetPage, fleetHomeLocation, fleetLocation, normalizeFleetPath, readFleetPath } from "./pages/fleet";
import { LicensesPage } from "./pages/licenses";
import { OperatorKeysPage } from "./pages/operator-keys";
import { WorkspacesPage } from "./pages/workspaces";
import { loginHref, signOutOfAdminPortal } from "./lib/session";
import { SignedOutScreen } from "./components/signed-out";
import {
  hasInvalidTestRunListScope, readTestRunLink, readTestRunListScope, testRunListLocation, testRunLocation, type TestRunLink,
} from "./lib/test-run-links";
import { RoutineCatalogPage, FrameworkRunsPage, FrameworkRunPage } from "./pages/routine-catalog";
import { SystemHealthPage, SystemHealthSummary } from "./pages/system-health";
import {readLaneSelection} from "./lib/lane-links";
import {readSystemHealthTab, systemHealthLocation, type SystemHealthTab} from "./lib/system-health-links";
import { RecordingVideo } from "./components/recording-video";

type Environment = "debug" | "dev" | "staging" | "prod";

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
  type: "logs" | "screenshot" | "state_snapshot" | "video";
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
  artifactCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

interface ReportDetailResponse {
  report: Omit<ReportSummary, "artifactCount"> & { artifacts: ReportArtifact[]; context: Record<string, unknown>; logCollection?: Record<string, {
    state: 'requested' | 'received' | 'failed' | 'unavailable' | 'timed-out'; reason?: string; entryCount?: number;
  }> };
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
  { key: "incidents", label: "Incident system", icon: Bug },
  { key: "fleet", label: "Fleet", icon: BarChart3 },
  { key: "test-runs", label: "Test runs", icon: FlaskConical },
  { key: "routine-catalog", label: "Routine catalog", icon: BookOpen },
  { key: "system-health", label: "System health", icon: ShieldCheck },
  { key: "workspaces", label: "Workspaces", icon: Users },
  { key: "licenses", label: "Licenses", icon: Ticket },
  { key: "operator-keys", label: "Operator keys", icon: KeyRound },
  { key: "audit", label: "Audit log", icon: History },
];

/** The navigation items for the pages this principal may open, in navigation order. */
export function visibleNav(visible: readonly AdminPageKey[]): NavItem[] {
  return ADMIN_NAV.filter(item => visible.includes(item.key as AdminPageKey));
}

/**
 * The page an address asks for, if any. The one place that orders the deep links, for the first load and for
 * Back and Forward alike: system health, Fleet, the test runs pages, the routine catalog, and (the first load
 * only, as `reportId`) an incident report.
 */
export function requestedPage(search: string, reportId: string | null = null): AdminPageKey | null {
  if (new URLSearchParams(search).get("systemHealth") === "1") return "system-health";
  if (readFleetPath(search) !== null) return "fleet";
  if (
    readPrCheckId(search) || readRerunId(search) || readSuiteId(search) || readTestRunLink(search) ||
    readTestRunListScope(search) || new URLSearchParams(search).get("testRuns") === "1"
  ) return "test-runs";
  if (new URLSearchParams(search).get("routineCatalog") === "1") return "routine-catalog";
  return reportId ? "incidents" : null;
}

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
const initialPrCheckId = readPrCheckId(window.location.search);
const initialRerunId = readRerunId(window.location.search);
const initialSuiteId = readSuiteId(window.location.search);
const initialTestRunLink = readTestRunLink(window.location.search);
const initialTestRunListScope = readTestRunListScope(window.location.search);
const initialHealthTab = readSystemHealthTab(window.location.search);
const initialFleetPath = readFleetPath(window.location.search);

function AdminPage() {
  const qc = useQueryClient();
  const env = ENVIRONMENT;
  // The page asked for, if any. What shows is `resolvePage(page, visible)`: a page this principal cannot
  // open (a deep link, say) falls back to their first visible page.
  const [page, setPage] = useState<AdminPageKey | null>(() => requestedPage(window.location.search, pendingDeepLinkReportId));
  const [prCheckId, setPrCheckId] = useState<string | null>(initialPrCheckId);
  const [rerunId, setRerunId] = useState<string | null>(initialRerunId);
  const [suiteId, setSuiteId] = useState<string | null>(initialSuiteId);
  const [healthTab, setHealthTab] = useState(initialHealthTab);
  // The Fleet route inside the Fleet page, from `?fleet=`.
  const [fleetPath, setFleetPath] = useState(initialFleetPath ?? "/");
  const [laneSelection, setLaneSelection] = useState(() => readLaneSelection(window.location.search));
  const [testRunLink, setTestRunLink] = useState<TestRunLink | null>(initialTestRunLink);
  const [testRunListScope, setTestRunListScope] = useState(initialTestRunListScope);
  const [invalidTestRunListScope, setInvalidTestRunListScope] = useState(() => hasInvalidTestRunListScope(window.location.search));
  const [deepLinkReportId, setDeepLinkReportId] = useState<string | null>(pendingDeepLinkReportId);
  const [signingOut, setSigningOut] = useState(false);
  const [signedOut, setSignedOut] = useState<{ signOutUrl: string | null } | null>(null);

  async function signOut() {
    setSigningOut(true);
    const result = await signOutOfAdminPortal();
    qc.clear();
    setSignedOut(result);
  }

  const me = useQuery({
    queryKey: ["admin-me"],
    queryFn: () => api<AdminMe>("/api/admin/me"),
    retry: false,
  });
  const visible = me.data ? visiblePages(me.data) : [];
  const active = resolvePage(page, visible);

  useEffect(() => {
    // The deep link is safe in state now, so drop it from the address bar —
    // but only once signed in; before that, LoginGate's return_to still needs
    // the parameter to survive the auth round-trip. Idempotent on re-runs.
    if (me.isSuccess && pendingDeepLinkReportId) {
      pendingDeepLinkReportId = null;
      const url = new URL(window.location.href);
      url.searchParams.delete("report");
      window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  }, [me.isSuccess]);
  useEffect(() => {
    const restore = () => {
      setHealthTab(readSystemHealthTab(window.location.search));
      setLaneSelection(readLaneSelection(window.location.search));
      const requested = requestedPage(window.location.search);
      if (requested === "system-health") { setPage("system-health"); return; }
      if (requested === "fleet") { setFleetPath(readFleetPath(window.location.search) ?? "/"); setPage("fleet"); return; }
      const prCheck = readPrCheckId(window.location.search);
      setPrCheckId(prCheck);
      const rerun = readRerunId(window.location.search);
      setRerunId(rerun);
      const suite = readSuiteId(window.location.search);
      setSuiteId(suite);
      const selection = readTestRunLink(window.location.search);
      const scope = readTestRunListScope(window.location.search);
      setTestRunLink(selection);
      setTestRunListScope(scope);
      setInvalidTestRunListScope(hasInvalidTestRunListScope(window.location.search));
      if (requested === "test-runs" || requested === "routine-catalog") setPage(requested);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  function selectHealthTab(tab: SystemHealthTab) {
    setHealthTab(tab);
    setLaneSelection(null);
    window.history.pushState(null, "", systemHealthLocation(window.location.href, tab));
  }

  function selectTestRun(selection: TestRunLink | null, replace = false) {
    setPrCheckId(null);
    setRerunId(null);
    setSuiteId(null);
    setTestRunLink(selection);
    window.history[replace ? "replaceState" : "pushState"](null, "", testRunLocation(window.location.href, selection));
  }

  // The Fleet module asked to go to a route: the address follows, and the new route reaches the module through `fleetPath`.
  function navigateFleet(to: string, opts?: { replace?: boolean }) {
    const route = normalizeFleetPath(to);
    const target = fleetLocation(window.location.href, route);
    const current = window.location.pathname + window.location.search + window.location.hash;
    setFleetPath(route);
    if (target !== current) window.history[opts?.replace ? "replaceState" : "pushState"](null, "", target);
  }

  function clearTestRunListScope() {
    setTestRunListScope(null);
    setInvalidTestRunListScope(false);
    window.history.replaceState(null, "", testRunListLocation(window.location.href, null));
  }

  const pageMeta: Record<AdminPageKey, { title: string; body: string }> = {
    incidents: { title: "Incident system", body: "Bug reports and feedback filed from the Mentra App, with their screenshots and log bundles." },
    fleet: { title: "Fleet", body: "Active people and glasses, firmware and Mentra App versions, and miniapp usage across this organization." },
    "test-runs": { title: "Test runs", body: "Recorded routines, build provenance, firmware checks, and fixture return state." },
    "routine-catalog": { title: "Routine catalog", body: "What each routine checks, what it needs, and a passing recording." },
    "system-health": { title: "System health", body: "Machines, lanes, framework, memory and disk." },
    workspaces: { title: "Workspaces", body: "Every workspace in this organization: members, invitations, keys, settings, audit, and ownership recovery." },
    licenses: { title: "Licenses", body: "Every license in this organization, workspace and personal: who holds it, its seats and what it is paid through." },
    "operator-keys": { title: "Operator keys", body: "Organization keys for incident, support-profile and test-run tooling." },
    audit: { title: "Audit log", body: "Admin actions recorded by Core, such as support-profile lookups." },
  };

  if (signedOut) return <SignedOutScreen signOutUrl={signedOut.signOutUrl} />;
  if (me.isLoading) return <Splash label="Checking admin session" />;
  if (me.isError) {
    // A 403 means the sign-in itself worked but this caller may not use the admin portal; offering the
    // sign-in button again would be misleading.
    return (
      <LoginGate
        denied={me.error instanceof ApiError && me.error.status === 403}
        onSignOut={signOut}
        signingOut={signingOut}
      />
    );
  }
  // Signed in, but no organization capability opens any page here: not an Organization Admin.
  if (!active) return <LoginGate denied onSignOut={signOut} signingOut={signingOut} />;
  const principal = me.data!;

  return (
    <AppShell
      brandTitle="Admin"
      brandSubtitle="MentraOS"
      badge={<EnvBadge env={env} />}
      nav={visibleNav(visible)}
      activeKey={active}
      onSelect={key => {
        setPage(key as AdminPageKey);
        setHealthTab("lanes");
        const location = new URL(window.location.href);
        for (const param of ["systemHealth", "healthTab", "restoration", "hostId", "laneId", "routineCatalog", "routine", "platform", "frameworkRun", "testSuite", "fleet"]) location.searchParams.delete(param);
        window.history.replaceState(null, "", location.pathname + location.search);
        // Any navigation spends the deep link: coming back to the Incident
        // system page starts unselected.
        setDeepLinkReportId(null);
        selectTestRun(null, true);
        clearTestRunListScope();
        if (key === "test-runs") window.history.replaceState(null, "", "/?testRuns=1");
        setLaneSelection(null);
        if (key === "system-health") window.history.replaceState(null, "", "/?systemHealth=1");
        setSuiteId(null);
        if (key === "routine-catalog") window.history.replaceState(null, "", "/?routineCatalog=1");
        setFleetPath("/");
        if (key === "fleet") window.history.replaceState(null, "", fleetHomeLocation());
      }}
      title={pageMeta[active].title}
      description={pageMeta[active].body}
      userEmail={principal.user?.email ?? principal.credential?.label ?? "Admin"}
      accountLabel="Admin"
      onSignOut={signOut}
      signingOut={signingOut}
    >
      {active === "incidents" ? <ReportsPage initialReportId={deepLinkReportId} /> : null}
      {active === "fleet" ? (
        <FleetPage
          me={principal}
          path={fleetPath}
          onNavigate={navigateFleet}
          // Ask Core who we are again. A session that has ended answers 401 there, and a failed admin-me query is
          // what shows the sign-in gate (which returns here afterwards, ?fleet= included).
          onSessionExpired={() => { void qc.invalidateQueries({ queryKey: ["admin-me"] }); }}
        />
      ) : null}
      {active === "workspaces" ? <WorkspacesPage /> : null}
      {active === "licenses" ? <LicensesPage /> : null}
      {active === "operator-keys" ? <OperatorKeysPage /> : null}
      {active === "audit" ? <AuditPage /> : null}
      <div className={["test-runs", "routine-catalog", "system-health"].includes(active) ? "testing-workspace" : undefined}>
      {active === "test-runs" ? <SystemHealthSummary /> : null}
      {active === "system-health" ? <SystemHealthPage tab={healthTab} lane={laneSelection} onTabChange={selectHealthTab} /> : null}
      {active === "routine-catalog" ? <RoutineCatalogPage /> : null}
      {active === "test-runs" && prCheckId ? <PrRoutineCheckPage gateId={prCheckId} /> : null}
      {active === "test-runs" && !prCheckId && rerunId ? <TestRerunPage rerunId={rerunId} /> : null}
      {active === "test-runs" && !prCheckId && !rerunId && suiteId ? <TestSuitePage suiteId={suiteId} /> : null}
      {active === "test-runs" && !prCheckId && !rerunId && !suiteId ? (
        testRunLink ? <FrameworkRunPage runId={testRunLink.runID} stepId={testRunLink.stepID} /> : <TestRunsTabs>
          {testRunListScope && <section className="rounded-2xl border border-[#e0e4de] bg-white p-5">
            <h2 className="font-semibold">Results for the selected build</h2>
            <p className="mt-2">{testRunListScope.repository} · {testRunListScope.channel} · <code>{testRunListScope.headSha}</code> · {testRunListScope.routineId} · {testRunListScope.platform}</p>
            <button className="mt-3 underline" onClick={() => {clearTestRunListScope(); window.history.replaceState(null, "", "/?testRuns=1");}}>Show all test runs</button>
          </section>}
          {invalidTestRunListScope ? <section role="alert" className="rounded-2xl border border-[#e0e4de] bg-white p-5">
            <h2 className="font-semibold">This test-results filter is unavailable</h2>
            <p className="mt-2">The link has missing or unsupported build details. Open a current result link, or choose all test runs.</p>
            <button className="mt-3 underline" onClick={() => {clearTestRunListScope(); window.history.replaceState(null, "", "/?testRuns=1");}}>Show all test runs</button>
          </section> : <FrameworkRunsPage scope={testRunListScope ? Object.fromEntries(Object.entries(testRunListScope).map(([key, value]) => [key === "pr" ? "prNumber" : key, value])) : undefined} />}
        </TestRunsTabs>
      ) : null}

      </div>
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

function AuditPage() {
  const audit = useQuery({
    queryKey: ["admin-audit"],
    queryFn: () => api<{ events: AuditEvent[] }>("/api/admin/audit-log"),
  });
  const events = audit.data?.events ?? [];
  const [filter, setFilter] = useState("");
  const filtered = events.filter(event => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return [event.action, event.targetType, event.targetId, event.adminId, event.reason ?? ""].some(value => value.toLowerCase().includes(q));
  });
  return (
    <section className="rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#eceeeb] p-5">
        <div>
          <h2 className="text-xl font-bold">Audit log</h2>
          <p className="mt-1 text-sm text-[#68746d]">{events.length} recorded admin actions.</p>
        </div>
        <input
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder="Filter by action, target, admin…"
          className="h-10 w-full max-w-xs rounded-full border border-[#e0e4de] bg-[#f7f8f6] px-4 text-sm outline-none focus:border-[#1bbd7e] focus:bg-white sm:w-72"
        />
      </div>
      {audit.isLoading ? (
        <div className="p-5"><InlineLoading label="Loading audit log" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState title="No matching events" body={events.length === 0 ? "Admin actions will be recorded here." : "Try a different filter."} />
      ) : (
        <div className="divide-y divide-[#eceeeb]">
          {filtered.map(event => <AuditRow key={event.id} event={event} />)}
        </div>
      )}
    </section>
  );
}

function AuditRow({ event }: { event: AuditEvent }) {
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
  const [category, setCategory] = useState<"all" | ReportKind | "internal" | "testing">("bug");
  const [status, setStatus] = useState<"all" | ReportStatus>("all");
  const [detailId, setDetailId] = useState<string | null>(initialReportId);

  const reports = useQuery({
    queryKey: ["admin-reports", category, status],
    queryFn: () => {
      const params = new URLSearchParams();
      if (category !== "all") params.set("category", category);
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
              Internal contains bugs and feedback from admin accounts. Testing contains harness reports; other automatic reports stay in Automatic.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <FilterPills
              value={category}
              onChange={setCategory}
              options={[["all", "All kinds"], ["bug", "Bug"], ["feedback", "Feedback"], ["internal", "Internal"], ["testing", "Testing"], ["automatic", "Automatic"]]}
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
          <EmptyState title="No reports" body={category === "internal" ? "Bugs and feedback submitted by admin accounts will appear here." : category === "testing" ? "Reports submitted by the automated testing harness will appear here." : "Reports matching these filters will appear here."} />
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
                    {report.artifactCount > 0 ? (
                      <span className="rounded-full bg-[#f0f2ef] px-2.5 py-0.5 text-xs font-semibold text-[#4f5d54]">
                        {report.artifactCount} artifact{report.artifactCount === 1 ? "" : "s"}
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
    <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-[18px] border border-[#e0e4de] bg-[#f7f8f6] p-1">
      {props.options.map(([value, label]) => (
        <button
          key={value}
          onClick={() => props.onChange(value)}
          className={`h-7 whitespace-nowrap rounded-full px-3 text-xs font-semibold ${
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
              {report.logCollection ? (
                <div className="rounded-[18px] border border-[#e0e4de] bg-white p-5">
                  <div className="text-xs font-medium uppercase tracking-[0.1em] text-[#a0a3aa]">Log collection</div>
                  <table className="mt-3 w-full text-left text-sm">
                    <thead><tr className="text-[#68746d]"><th className="py-2 font-medium">Source</th><th className="py-2 font-medium">Status</th><th className="py-2 font-medium">Details</th></tr></thead>
                    <tbody>{Object.entries(report.logCollection).map(([source, result]) => (
                      <tr key={source} className="border-t border-[#e0e4de]">
                        <td className="py-2">{source.replaceAll('_', ' ')}</td>
                        <td className={`py-2 ${result.state === 'received' ? 'text-green-700' : result.state === 'requested' ? 'text-[#68746d]' : 'text-amber-700'}`}>{result.state}</td>
                        <td className="py-2 text-[#68746d]">{result.state === 'received' ? `${result.entryCount ?? 0} entries` : result.reason ?? 'Waiting for upload'}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ) : null}

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
                  <p className="mt-2 text-sm text-[#68746d]">No screenshots, videos or logs were attached.</p>
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

function isPlayableVideo(contentType: string | null | undefined): boolean {
  return contentType?.split(";")[0].trim().toLowerCase() === "video/mp4";
}

export function ReportArtifactView({ reportId, artifact }: { reportId: string; artifact: ReportArtifact }) {
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
  if (artifact.type === "video" && isPlayableVideo(artifact.contentType)) {
    // Same-origin artifact URL, like screenshots: the browser sends the admin
    // session cookie and the API serves the MP4 inline.
    return (
      <div className="rounded-[14px] bg-[#f5f7f4] p-3">
        {header}
        <RecordingVideo
          src={url}
          className="mt-2 border border-[#e0e4de]"
        />
        <a className="mt-2 inline-flex items-center gap-2 text-sm font-semibold text-[#087d50]" href={url} download>
          <FileText className="size-4" /> Download payload
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

function reportSummaryText(report: Pick<ReportSummary, "report" | "feedback" | "trigger">): string {
  if (report.report?.actualBehavior) return String(report.report.actualBehavior);
  if (report.feedback) {
    if (typeof report.feedback.message === "string" && report.feedback.message) return report.feedback.message;
    const text = JSON.stringify(report.feedback);
    if (text && text !== "{}") return text;
  }
  return report.trigger?.reason ?? "—";
}

function formatBytes(bytes: number): string {
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

export function LoginGate({ denied = false, onSignOut, signingOut = false }: { denied?: boolean; onSignOut?: () => void; signingOut?: boolean }) {
  // The relative path and query preserve report and testRun/step deep links
  // through the sign-in round trip; Core accepts only a relative return_to.
  const loginUrl = loginHref();

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
                ? "You're signed in, but this account has no administrator access here: that needs a verified email on the Core admin allowlist. Manage your own workspaces in Mentra Portal, switch accounts, or ask for your email to be added."
                : "Triage incidents, follow test runs, and manage workspaces and other internal operations."}
            </p>

            <div className="h-8" />
            {denied ? (
              <button
                type="button"
                className="flex h-[48px] w-full items-center justify-center rounded-full bg-[#14141a] px-[18px] font-display text-sm font-semibold text-white shadow-[0_18px_44px_-10px_rgba(20,20,26,0.25),inset_0_1px_0_rgba(255,255,255,0.14)] transition hover:bg-[#24242b] focus:outline-none focus:ring-4 focus:ring-[#14141a]/10"
                onClick={onSignOut}
                disabled={signingOut}
              >
                Sign out and switch account
              </button>
            ) : (
              <a
                className="flex h-[48px] w-full items-center justify-center rounded-full bg-[#14141a] px-[18px] font-display text-sm font-semibold text-white shadow-[0_18px_44px_-10px_rgba(20,20,26,0.25),inset_0_1px_0_rgba(255,255,255,0.14)] transition hover:bg-[#24242b] focus:outline-none focus:ring-4 focus:ring-[#14141a]/10"
                href={loginUrl}
              >
                Sign in
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
        <LoadingIndicator inline label={props.label} />
      </div>
    </main>
  );
}

function InlineLoading(props: { label: string }) {
  return <LoadingIndicator label={props.label} />;
}

function ErrorText({ error }: { error: unknown }) {
  return (
    <p className="mt-3 rounded-[14px] bg-[#fff3f1] p-3 text-sm text-[#a64235]">
      {error instanceof Error ? error.message : "Request failed"}
    </p>
  );
}

export default App;
