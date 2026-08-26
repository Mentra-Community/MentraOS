import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, ChevronLeft } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PackageName } from "@/components/package-name";
import { Badge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { sessionQuery } from "@/features/session/session.queries";
import { appsQuery } from "./apps.queries";
import { listDeveloperReleases, submitDeveloperRelease, type DeveloperRelease } from "./apps.api";
import { BetaAccessCard } from "./beta-access-card";
import { StoreListingCard } from "./store-listing-card";

const reviewStatuses = new Set(["submitted", "in_review"]);

export function MiniappDetailPage() {
  const { packageName } = useParams({ from: "/apps/$packageName" });
  const queryClient = useQueryClient();
  const session = useQuery(sessionQuery());
  const canLoadPrivateData = session.isSuccess && !session.data.onboardingRequired;
  const apps = useQuery(appsQuery(canLoadPrivateData));
  const releasesQuery = useQuery({
    queryKey: ["developer-releases", packageName],
    queryFn: () => listDeveloperReleases(packageName),
    enabled: canLoadPrivateData,
  });
  const submitRelease = useMutation({
    mutationFn: (releaseId: string) => submitDeveloperRelease({ packageName, releaseId }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["developer-releases", packageName] }),
        queryClient.invalidateQueries({ queryKey: ["developer-apps"] }),
      ]);
    },
  });

  const app = apps.data?.apps.find(item => item.packageName === packageName);
  const releases = releasesQuery.data?.releases ?? [];
  const packagePrefix = session.data?.packagePrefix;
  const publishedStable = app?.activeRelease ?? releases.find(release => release.status === "published" && release.releaseTrack === "stable") ?? null;
  const publishedBeta = app?.activeBetaRelease ?? releases.find(release => release.status === "published" && release.releaseTrack === "beta") ?? null;
  const inReview = releases.find(release => reviewStatuses.has(release.status));

  return (
    <AppShell>
      <main className="mx-auto w-full max-w-[1040px] px-4 py-4 sm:px-5 sm:py-6 md:px-8 md:py-8">
        <Link
          to="/apps"
          className="inline-flex items-center gap-1 text-sm font-medium text-[#68746d] hover:text-[#111217]">
          <ChevronLeft className="size-4" />
          Miniapps
        </Link>

        <header className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-display text-[24px] font-bold tracking-[-0.02em] text-[#14151b]">
              {app?.name ?? packageName}
            </h1>
            <div className="mt-1.5">
              <PackageName packageName={packageName} packagePrefix={packagePrefix} />
            </div>
          </div>
          {app ? <Badge tone={app.status === "active" ? "success" : "neutral"}>{app.status}</Badge> : null}
        </header>

        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <ReleaseSummaryCard label="Stable track" release={publishedStable} empty="No stable release yet" />
          <ReleaseSummaryCard label="Beta track" release={publishedBeta} empty="No beta release yet" />
          <ReleaseSummaryCard label="In review" release={inReview ?? null} empty="Nothing in review" />
        </div>

        <StoreListingCard packageName={packageName} />
        <BetaAccessCard packageName={packageName} />

        {releases[0]?.manifest ? (
          <Card className="mt-6 rounded-[16px] border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)] sm:rounded-[18px]">
            <CardHeader className="border-b border-[#eceeeb] px-4 py-4 sm:px-6 sm:py-5">
              <CardTitle className="font-display text-[18px]">Canonical release manifest</CardTitle>
            </CardHeader>
            <CardContent className="p-4 sm:p-6">
              <pre className="max-h-[360px] overflow-auto rounded-xl bg-[#151816] p-4 text-xs leading-5 text-[#dce5de]">
                {JSON.stringify(releases[0].manifest, null, 2)}
              </pre>
              {releases[0].manifestSha256 ? (
                <p className="mt-2 break-all font-mono text-xs text-[#747780]">SHA-256 {releases[0].manifestSha256}</p>
              ) : null}
              {releases[0].signingKeyId ? (
                <p className="mt-1 break-all font-mono text-xs text-[#747780]">
                  Signing key {releases[0].signingKeyId}
                  {releases[0].signedAt ? ` · signed ${formatDate(releases[0].signedAt)}` : ""}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        <Card className="mt-6 overflow-hidden rounded-[16px] border-[#e0e4de] bg-white py-0 shadow-[0_1px_2px_rgba(20,21,27,0.06)] sm:rounded-[18px]">
          <CardHeader className="border-b border-[#eceeeb] px-4 py-4 sm:px-6 sm:py-5">
            <CardTitle className="font-display text-[18px]">Release history</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {releasesQuery.isLoading ? (
              <div className="p-6 text-sm text-[#747780]">Loading releases…</div>
            ) : releases.length === 0 ? (
              <div className="flex min-h-[220px] flex-col items-center justify-center p-8 text-center">
                <div className="flex size-12 items-center justify-center rounded-[14px] bg-[#e9f8f1] text-[#087d50]">
                  <Boxes className="size-6" />
                </div>
                <h2 className="mt-5 font-display text-[19px] font-bold">No releases yet</h2>
                <p className="mt-2 max-w-md text-sm leading-6 text-[#747780]">
                  Build and upload your first release from your project with{" "}
                  <code className="rounded bg-[#f0f2ef] px-1.5 py-0.5 font-mono text-[13px]">mentra publish</code>.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[#eceeeb]">
                {releases.map(release => (
                  <div
                    key={release.id}
                    className="grid gap-3 px-4 py-4 sm:px-6 md:grid-cols-[120px_minmax(0,1fr)_140px] md:items-center">
                    <div className="font-mono text-sm font-semibold text-[#1c1d22]">{release.version}</div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <ReleaseStatusBadge status={release.status} />
                        <span className="text-xs font-medium text-[#a0a3aa]">{release.releaseTrack} track</span>
                      </div>
                      {release.reviewNotes ? (
                        <p className="mt-1.5 line-clamp-2 text-sm text-[#68746d]">Review: {release.reviewNotes}</p>
                      ) : null}
                      <div className="mt-1 truncate font-mono text-xs text-[#a0a3aa]">
                        {formatBytes(release.bundleSizeBytes)}
                        {release.bundleSha256 ? ` · ${release.bundleSha256.slice(0, 12)}…` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 md:flex-col md:items-end">
                      <div className="text-sm text-[#747780]">{formatDate(release.createdAt)}</div>
                      <Link
                        to="/apps/$packageName/releases/$releaseId"
                        params={{ packageName, releaseId: release.id }}
                        className="text-sm font-semibold text-[#087d50] hover:text-[#065f3e]"
                      >
                        View details
                      </Link>
                      {release.status === "draft" || release.status === "rejected" ? (
                        <Button
                          size="sm"
                          className="rounded-full bg-[#111217] text-white hover:bg-[#25262c]"
                          disabled={submitRelease.isPending}
                          onClick={() => submitRelease.mutate(release.id)}>
                          {submitRelease.isPending && submitRelease.variables === release.id
                            ? "Submitting…"
                            : "Submit for review"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
                {submitRelease.error ? (
                  <div className="px-4 py-3 text-sm text-red-700 sm:px-6">
                    {submitRelease.error instanceof Error ? submitRelease.error.message : "Could not submit release"}
                  </div>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </AppShell>
  );
}

function ReleaseSummaryCard({
  label,
  release,
  empty,
}: {
  label: string;
  release: DeveloperRelease | { version: string; status: string } | null;
  empty: string;
}) {
  return (
    <Card className="rounded-[16px] border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)] sm:rounded-[18px]">
      <CardContent className="p-5">
        <div className="text-xs font-medium uppercase tracking-[0.1em] text-[#a0a3aa]">{label}</div>
        {release ? (
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="font-mono text-lg font-bold">{release.version}</span>
            <ReleaseStatusBadge status={release.status} />
          </div>
        ) : (
          <div className="mt-2 text-sm text-[#747780]">{empty}</div>
        )}
      </CardContent>
    </Card>
  );
}

function ReleaseStatusBadge({ status }: { status: string }) {
  const tone: Record<string, "success" | "warn" | "neutral"> = {
    published: "success",
    accepted: "success",
    in_review: "warn",
    submitted: "warn",
    rejected: "neutral",
    suspended: "neutral",
    draft: "neutral",
  };
  return <Badge tone={tone[status] ?? "neutral"}>{status.replace("_", " ")}</Badge>;
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}
