import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Badge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { sessionQuery } from "@/features/session/session.queries";
import { listDeveloperReleases } from "./apps.api";

export function ReleaseDetailPage() {
  const { packageName, releaseId } = useParams({ from: "/apps/$packageName/releases/$releaseId" });
  const session = useQuery(sessionQuery());
  const releases = useQuery({
    queryKey: ["developer-releases", packageName],
    queryFn: () => listDeveloperReleases(packageName),
    enabled: session.isSuccess && !session.data.onboardingRequired,
  });
  const release = releases.data?.releases.find(candidate => candidate.id === releaseId);

  return (
    <AppShell>
      <main className="mx-auto w-full max-w-[960px] px-4 py-4 sm:px-5 sm:py-6 md:px-8 md:py-8">
        <Link
          to="/apps/$packageName"
          params={{ packageName }}
          className="inline-flex items-center gap-1 text-sm font-medium text-[#68746d] hover:text-[#111217]"
        >
          <ChevronLeft className="size-4" />
          {packageName}
        </Link>

        {releases.isLoading ? <p className="mt-8 text-sm text-[#747780]">Loading release…</p> : null}
        {releases.isError ? (
          <p role="alert" className="mt-8 rounded-xl bg-red-50 p-4 text-sm text-red-700">
            {releases.error instanceof Error ? releases.error.message : "Could not load release"}
          </p>
        ) : null}
        {!releases.isLoading && releases.isSuccess && !release ? (
          <p className="mt-8 rounded-xl border border-[#e0e4de] bg-white p-6 text-sm text-[#747780]">
            Release not found.
          </p>
        ) : null}

        {release ? (
          <>
            <header className="mt-5 flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="text-xs font-medium uppercase tracking-[0.1em] text-[#a0a3aa]">Release</div>
                <h1 className="mt-1 font-mono text-[26px] font-bold text-[#14151b]">{release.version}</h1>
                <p className="mt-1 font-mono text-sm text-[#68746d]">{packageName}</p>
              </div>
              <ReleaseStatus status={release.status} />
            </header>

            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="Uploaded" value={formatDate(release.createdAt)} />
              <Fact label="Bundle size" value={formatBytes(release.bundleSizeBytes)} />
              <Fact label="Signing key" value={release.signingKeyId ?? "—"} mono />
              <Fact label="Signed" value={formatDate(release.signedAt)} />
            </div>

            {release.reviewNotes ? (
              <Card className="mt-6 rounded-[18px] border-[#f0d2cc] bg-[#fff9f7]">
                <CardHeader className="pb-2">
                  <CardTitle className="font-display text-[17px]">Review feedback</CardTitle>
                </CardHeader>
                <CardContent className="text-sm leading-6 text-[#704c47]">{release.reviewNotes}</CardContent>
              </Card>
            ) : null}

            <Card className="mt-6 rounded-[18px] border-[#e0e4de] bg-white">
              <CardHeader className="border-b border-[#eceeeb]">
                <CardTitle className="font-display text-[18px]">Integrity</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 p-5 sm:grid-cols-2">
                <Hash label="Bundle SHA-256" value={release.bundleSha256} />
                <Hash label="Manifest SHA-256" value={release.manifestSha256} />
              </CardContent>
            </Card>

            <Card className="mt-6 rounded-[18px] border-[#e0e4de] bg-white">
              <CardHeader className="border-b border-[#eceeeb]">
                <CardTitle className="font-display text-[18px]">Canonical manifest</CardTitle>
              </CardHeader>
              <CardContent className="p-5">
                {release.manifest ? (
                  <pre className="max-h-[560px] overflow-auto rounded-xl bg-[#151816] p-4 text-xs leading-5 text-[#dce5de]">
                    {JSON.stringify(release.manifest, null, 2)}
                  </pre>
                ) : (
                  <p className="text-sm text-[#747780]">No canonical manifest is available.</p>
                )}
              </CardContent>
            </Card>
          </>
        ) : null}
      </main>
    </AppShell>
  );
}

function ReleaseStatus({ status }: { status: string }) {
  const tone = status === "published" || status === "accepted"
    ? "success"
    : status === "submitted" || status === "in_review"
      ? "warn"
      : "neutral";
  return <Badge tone={tone}>{status.replace("_", " ")}</Badge>;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 rounded-[16px] border border-[#e0e4de] bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-[0.08em] text-[#a0a3aa]">{label}</div>
      <div className={`mt-2 truncate text-sm font-semibold text-[#1c1d22] ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function Hash({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium uppercase tracking-[0.08em] text-[#a0a3aa]">{label}</div>
      <div className="mt-2 break-all font-mono text-xs leading-5 text-[#4f5d54]">{value ?? "—"}</div>
    </div>
  );
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
