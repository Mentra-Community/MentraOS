import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, ExternalLink, Film, Loader2, RefreshCcw, Search } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { api } from "../lib/api";
import { TestDispatchPanel } from "./test-dispatches";
import { readRecordingTimeline, TestRunRecordings } from "./test-run-recordings";
import { readTestRunLink, testRunAssetPath, type TestRunLink, type TestRunListScope } from "../lib/test-run-links";
import {
  chapterSeekTime,
  EMPTY_FILTERS,
  FIRMWARE_PHASE_LABELS,
  initialChapter,
  safeProducerUrl,
  testRunListPath,
  valueText,
  type TestRunAsset,
  type TestRunChapter,
  type TestRunDetail,
  type TestRunFilters,
  type TestRunSummary,
} from "./test-runs-data";

const PANEL = "rounded-[24px] border border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)]";
const INPUT = "h-9 rounded-lg border border-[#dfe3dc] bg-white px-3 text-sm";

export function TestRunsPage({
  selection,
  onSelect,
  scope = null,
  onClearScope,
}: {
  selection: TestRunLink | null;
  onSelect: (selection: TestRunLink | null, replace?: boolean) => void;
  scope?: TestRunListScope | null;
  onClearScope?: () => void;
}) {
  const [draft, setDraft] = useState<TestRunFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<TestRunFilters>(EMPTY_FILTERS);
  const [filterError, setFilterError] = useState<string | null>(null);
  const runs = useInfiniteQuery({
    queryKey: ["admin-test-runs", filters, scope],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<{ runs: TestRunSummary[]; nextCursor: string | null }>(testRunListPath(filters, pageParam, scope)),
    getNextPageParam: (response) => response.nextCursor ?? undefined,
    enabled: !selection,
  });
  const update = (key: keyof TestRunFilters, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  if (selection)
    return (
      <TestRunDetailPage
        runId={selection.runID}
        stepId={selection.stepID}
        onBack={() => onSelect(null)}
        onStep={(stepID) => onSelect({ runID: selection.runID, stepID }, true)}
      />
    );
  const rows = runs.data?.pages.flatMap((page) => page.runs) ?? [];
  const additionalFilters = !!(filters.outcome || filters.fixtureAlias || filters.startedAfter || filters.startedBefore);
  return (
    <section className={PANEL}>
      <TestDispatchPanel onResult={runID => onSelect({ runID })} />
      <div className="border-b border-[#eceeeb] p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">Recorded routines</h2>
            <p className="mt-1 text-sm text-[#68746d]">
              Open a run to review the tested build, English steps, recordings and return checks.
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh test runs"
            disabled={runs.isFetching}
            onClick={() => runs.refetch()}>
            <RefreshCcw className={`size-4 ${runs.isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
        {scope ? (
          <div className="mt-4 rounded-lg bg-[#f2f7f3] p-3 text-sm">
            <p className="font-semibold">
              Results for {scope.repository} PR #{scope.pr} · commit {scope.headSha.slice(0, 7)}
            </p>
            <p className="mt-1 break-all text-xs text-[#68746d]">App archive SHA256: {scope.archiveSha256}</p>
            <Button className="mt-2" variant="outline" onClick={onClearScope}>
              Show all builds
            </Button>
          </div>
        ) : null}
        <form
          className="mt-5 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              testRunListPath(draft, undefined, scope);
              setFilters({ ...draft });
              setFilterError(null);
            } catch (error) {
              setFilterError(String(error instanceof Error ? error.message : error));
            }
          }}>
          <Filter label="PR number">
            <Input
              className="w-28"
              inputMode="numeric"
              value={scope?.pr ?? draft.pr}
              disabled={!!scope}
              onChange={(event) => update("pr", event.target.value)}
              placeholder="All PRs"
              aria-label="PR number"
            />
          </Filter>
          <Filter label="Channel">
            <select
              aria-label="Channel"
              className={INPUT}
              value={scope ? "pr" : draft.channel}
              disabled={!!scope}
              onChange={(event) => update("channel", event.target.value)}>
              {[
                ["", "All channels"],
                ["pr", "PR"],
                ["dev", "Dev"],
                ["staging", "Staging"],
                ["local", "Local"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Filter>
          <Filter label="Outcome">
            <select
              aria-label="Outcome"
              className={INPUT}
              value={draft.outcome}
              onChange={(event) => update("outcome", event.target.value)}>
              {[
                ["", "Any outcome"],
                ["passed", "Passed"],
                ["failed", "Failed"],
                ["blocked", "Blocked"],
                ["aborted", "Aborted"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Filter>
          <Filter label="Platform">
            <select
              aria-label="Platform"
              className={INPUT}
              value={scope?.platform ?? draft.platform}
              disabled={!!scope}
              onChange={(event) => update("platform", event.target.value)}>
              {[
                ["", "All platforms"],
                ["ios-mac", "iOS on Mac"],
                ["ios", "iPhone"],
                ["android", "Android"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Filter>
          <Filter label="Routine">
            <Input
              className="w-44"
              value={scope?.routineId ?? draft.routineId}
              disabled={!!scope}
              onChange={(event) => update("routineId", event.target.value)}
              placeholder="All routines"
              aria-label="Routine ID"
            />
          </Filter>
          <Filter label="Fixture">
            <Input
              className="w-36"
              value={draft.fixtureAlias}
              onChange={(event) => update("fixtureAlias", event.target.value)}
              placeholder="All fixtures"
              aria-label="Fixture alias"
            />
          </Filter>
          <Filter label="From">
            <Input
              type="text"
              placeholder="YYYY-MM-DD"
              pattern="\d{4}-\d{2}-\d{2}"
              value={draft.startedAfter}
              onChange={(event) => update("startedAfter", event.target.value)}
              aria-label="Started from date"
            />
          </Filter>
          <Filter label="Through">
            <Input
              type="text"
              placeholder="YYYY-MM-DD"
              pattern="\d{4}-\d{2}-\d{2}"
              value={draft.startedBefore}
              onChange={(event) => update("startedBefore", event.target.value)}
              aria-label="Started through date"
            />
          </Filter>
          <Button type="submit" variant="outline">
            Apply filters
          </Button>
        </form>
        {filterError ? (
          <p role="alert" className="mt-3 text-sm text-[#a64235]">
            {filterError}
          </p>
        ) : null}
      </div>
      {runs.isLoading ? (
        <Loading label="Loading test runs" />
      ) : runs.isError ? (
        <Failure error={runs.error} />
      ) : rows.length === 0 ? (
        <Empty
          title={scope && !additionalFilters ? "No results for this build yet" : "No test runs match these filters"}
          body={
            scope && !additionalFilters
              ? "Results appear after the device run is uploaded. A requested test is not a completed test."
              : "Completed routine results will appear here after they are uploaded. Try a different filter."
          }
        />
      ) : (
        <>
          <div className="divide-y divide-[#eceeeb]">
            {rows.map((run) => (
              <button
                key={run.runId}
                type="button"
                className="block w-full p-5 text-left hover:bg-[#fafbfa]"
                onClick={() => onSelect({ runID: run.runId })}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Outcome value={run.outcome} />
                      <span className="text-xs font-semibold uppercase tracking-wide text-[#68746d]">
                        {run.channel} · {platformName(run.platform)}
                      </span>
                      {run.prNumber ? <span className="text-xs font-semibold">PR #{run.prNumber}</span> : null}
                    </div>
                    <h3 className="mt-2 font-semibold">{run.routineId}</h3>
                    <p className="mt-1 text-xs text-[#747780]">
                      {run.fixture.alias} · {run.release ?? short(run.provenance.buildSha ?? run.provenance.headSha)} ·{" "}
                      {date(run.startedAt)}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-[#087d50]">Review →</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Outcome label="Test" value={run.outcomes.test} />
                  <Outcome label="Teardown" value={run.outcomes.teardown} />
                  <Outcome label="Fixture" value={run.outcomes.fixture} />
                  <Outcome label="Evidence" value={run.outcomes.evidence} />
                </div>
              </button>
            ))}
          </div>
          {runs.hasNextPage ? (
            <div className="border-t border-[#eceeeb] p-4 text-center">
              <Button variant="outline" disabled={runs.isFetchingNextPage} onClick={() => runs.fetchNextPage()}>
                {runs.isFetchingNextPage ? "Loading…" : "Load more runs"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function TestRunDetailPage({
  runId,
  stepId,
  onBack,
  onStep,
}: {
  runId: string;
  stepId?: string;
  onBack: () => void;
  onStep: (id: string) => void;
}) {
  const detail = useQuery({
    queryKey: ["admin-test-run", runId],
    queryFn: () => api<TestRunDetail>(`/api/admin/test-runs/${encodeURIComponent(runId)}`),
  });
  return (
    <div className="space-y-5">
      <div className="flex justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="size-4" /> All test runs
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh test run"
          disabled={detail.isFetching}
          onClick={() => detail.refetch()}>
          <RefreshCcw className={`size-4 ${detail.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>
      {detail.isLoading ? (
        <Loading label="Loading test run" />
      ) : detail.isError ? (
        <Failure error={detail.error} />
      ) : detail.data ? (
        <TestRunView key={runId} run={detail.data} stepId={stepId} onStep={onStep} />
      ) : (
        <Empty title="Test run unavailable" body="No run details were returned." />
      )}
    </div>
  );
}

/** Trusted React viewer only: report HTML/JavaScript is never mounted or executed. */
export function TestRunView({
  run,
  stepId,
  onStep,
}: {
  run: TestRunDetail;
  stepId?: string;
  onStep: (id: string) => void;
}) {
  const selected = initialChapter(run.chapters, stepId);
  const [search, setSearch] = useState("");
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [recordingSeekSequence, setRecordingSeekSequence] = useState(0);
  const recordingTimeline = readRecordingTimeline(run.provenance.recordingTimeline, run.assets);
  const video = useRef<HTMLVideoElement>(null);
  const videoAsset = selected
    ? run.assets.find((asset) => asset.assetId === selected.videoAssetId && asset.kind === "video")
    : run.assets.find((asset) => asset.kind === "video");
  const screenshot = run.assets.find(
    (asset) => asset.assetId === selected?.screenshotAssetId && asset.kind === "screenshot",
  );
  const playable =
    videoAsset?.uploaded &&
    ["video/mp4", "video/webm", "video/quicktime"].includes(videoAsset.contentType.split(";")[0].toLowerCase());
  function seek() {
    if (!selected || !videoAsset || !video.current) return;
    const time = chapterSeekTime(selected, videoAsset, video.current.duration);
    if (time === null) {
      setMediaError("This step has no valid timestamp within the recording.");
      return;
    }
    try {
      video.current.currentTime = time;
      setMediaError(null);
    } catch {
      setMediaError("The recording could not seek to this step. Try reloading it.");
    }
  }
  useEffect(() => {
    setMediaError(null);
    if (video.current && video.current.readyState >= 1) seek();
  }, [selected?.id, videoAsset?.assetId]);
  const chapters = run.chapters.filter((chapter) =>
    `${chapter.id} ${chapter.instruction}`.toLowerCase().includes(search.toLowerCase()),
  );
  const producer = safeProducerUrl(run.provenance.producerUrl);
  const originalRunId =
    typeof run.provenance.originalRunId === "string" && run.provenance.originalRunId !== run.runId
      ? readTestRunLink(new URLSearchParams({ testRun: run.provenance.originalRunId }).toString())?.runID
      : null;
  return (
    <>
      <section className={`${PANEL} p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Outcome value={run.outcome} />
              <span className="text-xs font-semibold uppercase tracking-wide text-[#68746d]">
                {run.channel} · {platformName(run.platform)}
              </span>
            </div>
            <h2 className="mt-3 text-xl font-bold">{run.routineId}</h2>
            <p className="mt-1 break-all font-mono text-xs text-[#747780]">{run.runId}</p>
          </div>
          {producer ? (
            <a
              href={producer}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-sm font-semibold text-[#087d50]">
              Build in CI <ExternalLink className="size-4" />
            </a>
          ) : null}
        </div>
        {originalRunId ? (
          <aside aria-label="Recovery result" className="mt-4 rounded-xl bg-[#f5f7f4] p-3 text-sm text-[#4f5d54]">
            <span className="font-semibold">Recovery result.</span> The original test outcome is preserved.{" "}
            <a
              href={`/?testRun=${encodeURIComponent(originalRunId)}`}
              className="font-semibold text-[#087d50] underline">
              View original run
            </a>
          </aside>
        ) : null}
        <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
          {Object.entries(run.outcomes).map(([label, value]) => (
            <div key={label} className="rounded-xl bg-[#f5f7f4] p-3">
              <p className="mb-2 text-xs font-semibold capitalize text-[#68746d]">{label}</p>
              <Outcome value={value} />
            </div>
          ))}
        </div>
        {run.notes ? <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-[#4f5d54]">{run.notes}</p> : null}
      </section>

      <section className={PANEL}>
        <div className="border-b border-[#eceeeb] px-5 py-4">
          <h3 className="font-semibold">Routine recording</h3>
          <p className="mt-1 text-sm text-[#68746d]">Select an English step to jump to its recording and screenshot.</p>
        </div>
        <div className="grid lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="border-b border-[#eceeeb] p-4 lg:border-r lg:border-b-0">
            <label className="relative block">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-[#747780]" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label="Search English steps"
                placeholder="Search steps"
                className="pl-8"
              />
            </label>
            <div className="mt-3 max-h-[640px] space-y-1 overflow-y-auto">
              {chapters.length ? (
                chapters.map((chapter) => (
                  <button
                    key={chapter.id}
                    type="button"
                    aria-current={selected?.id === chapter.id ? "step" : undefined}
                    className={`w-full rounded-xl p-3 text-left ${selected?.id === chapter.id ? "bg-[#edf6f0] ring-1 ring-[#cde4d5]" : "hover:bg-[#f5f7f4]"}`}
                    onClick={() => {
                      setRecordingSeekSequence(value => value + 1);
                      onStep(chapter.id);
                      if (selected?.id === chapter.id) seek();
                    }}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-[#68746d]">
                        {chapter.phase}
                      </span>
                      <Outcome value={chapter.status} />
                    </div>
                    <div className="text-sm leading-5">{chapter.instruction}</div>
                    <div className="mt-1 text-[10px] text-[#747780]">
                      {chapter.id}
                      {chapter.videoStart !== undefined ? ` · ${time(chapter.videoStart)}` : ""}
                    </div>
                  </button>
                ))
              ) : (
                <p className="p-3 text-sm text-[#747780]">
                  {run.chapters.length ? "No matching steps." : "No steps were recorded."}
                </p>
              )}
            </div>
          </div>
          <div className="min-w-0 p-5">
            {stepId && !run.chapters.some((chapter) => chapter.id === stepId) ? (
              <p role="status" className="mb-3 text-sm text-[#a64235]">
                The linked step was not found. Showing the first failed or recorded step.
              </p>
            ) : null}
            {run.provenance.recordingTimeline && !recordingTimeline ? (
              <p role="status" className="mb-3 text-sm text-[#a64235]">Recording synchronization metadata is invalid. Showing the selected recording independently.</p>
            ) : null}
            {recordingTimeline ? (
              <TestRunRecordings key={run.runId} runId={run.runId} assets={run.assets} timeline={recordingTimeline}
                selected={selected} seekSequence={recordingSeekSequence} />
            ) : playable && videoAsset ? (
              <video
                key={videoAsset.assetId}
                ref={video}
                src={testRunAssetPath(run.runId, videoAsset.assetId)}
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={seek}
                onError={() =>
                  setMediaError(
                    "Recording unavailable. The upload may be incomplete or your admin session may have expired.",
                  )
                }
                className="max-h-[560px] w-full rounded-xl bg-[#111217]"
                aria-label="Routine recording"
              />
            ) : (
              <div className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-xl bg-[#f5f7f4] p-6 text-center text-[#68746d]">
                <Film className="size-7" />
                <p className="text-sm">
                  {videoAsset && !videoAsset.uploaded
                    ? "Recording upload is incomplete."
                    : selected
                      ? "No playable recording was captured for this step."
                      : "No recording was uploaded."}
                </p>
              </div>
            )}
            {!recordingTimeline && mediaError ? (
              <p role="alert" className="mt-3 text-sm text-[#a64235]">
                {mediaError}
              </p>
            ) : null}
            {!recordingTimeline && videoAsset?.uploaded ? (
              <a
                href={testRunAssetPath(run.runId, videoAsset.assetId)}
                download
                className="mt-2 inline-block text-xs font-semibold text-[#087d50]">
                Download recording · {bytes(videoAsset.sizeBytes)}
              </a>
            ) : null}
            {selected ? (
              <div className="mt-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-semibold">{selected.instruction}</h4>
                  <Outcome value={selected.status} />
                </div>
                {selected.expected ? (
                  <p className="mt-2 text-sm leading-6 text-[#68746d]">
                    <span className="font-semibold">Expected:</span> {selected.expected}
                  </p>
                ) : null}
                {screenshot ? (
                  <Screenshot
                    key={screenshot.assetId}
                    runId={run.runId}
                    asset={screenshot}
                    description={selected.instruction}
                  />
                ) : (
                  <p className="mt-3 text-xs text-[#747780]">No screenshot is attached to this step.</p>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className={PANEL}>
        <div className="border-b border-[#eceeeb] px-5 py-4">
          <h3 className="font-semibold">Firmware and return checks</h3>
        </div>
        {!run.firmwareAssertions.length ? (
          <Empty
            title="No firmware assertions recorded"
            body="This run has no uploaded expected/actual firmware evidence."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-[#fafbfa] text-xs text-[#747780]">
                <tr>
                  {["Phase", "Check", "Expected", "Observed", "Result"].map((label) => (
                    <th key={label} className="px-5 py-3 font-semibold">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#eceeeb]">
                {run.firmwareAssertions.map((assertion, index) => (
                  <tr key={`${assertion.component}-${index}`}>
                    <td className="px-5 py-4 align-top">
                      {assertion.phase ? FIRMWARE_PHASE_LABELS[assertion.phase] : "Not recorded"}
                    </td>
                    <th className="max-w-48 break-words px-5 py-4 align-top font-medium">{assertion.component}</th>
                    <td className="max-w-72 px-5 py-4 align-top">
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
                        {valueText(assertion.expected)}
                      </pre>
                    </td>
                    <td className="max-w-72 px-5 py-4 align-top">
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
                        {valueText(assertion.actual)}
                      </pre>
                    </td>
                    <td className="px-5 py-4 align-top">
                      <Outcome value={assertion.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={`${PANEL} p-5`}>
        <h3 className="font-semibold">Tested build and provenance</h3>
        <dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {[
            ["Routine version", run.routineVersion],
            ["Request", run.requestId],
            ["Fixture", run.fixture.alias],
            ["PR", run.prNumber ? `#${run.prNumber}` : undefined],
            ["Release", run.release],
            ["Started", date(run.startedAt)],
            ["Finished", date(run.finishedAt)],
            ...Object.entries(run.provenance).filter(([key]) => key !== "producerUrl"),
          ]
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs font-medium text-[#747780]">{label}</dt>
                <dd className="mt-1 break-all font-mono text-xs leading-5">{value}</dd>
              </div>
            ))}
        </dl>
      </section>
      <section className={`${PANEL} p-5`}>
        <h3 className="font-semibold">Evidence files</h3>
        {!run.assets.length ? (
          <p className="mt-3 text-sm text-[#747780]">No assets have been uploaded.</p>
        ) : (
          <ul className="mt-3 divide-y divide-[#eceeeb]">
            {run.assets.map((asset) => (
              <li key={asset.assetId} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div className="min-w-0">
                  <p className="break-all font-medium">{asset.filename}</p>
                  <p className="mt-1 text-xs text-[#747780]">
                    {asset.kind} · {bytes(asset.sizeBytes)} · {asset.contentType}
                  </p>
                </div>
                {asset.uploaded ? (
                  <a
                    href={testRunAssetPath(run.runId, asset.assetId)}
                    download
                    className="font-semibold text-[#087d50]">
                    Download
                  </a>
                ) : (
                  <span className="text-xs text-[#a64235]">Not uploaded</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Screenshot({ runId, asset, description }: { runId: string; asset: TestRunAsset; description: string }) {
  const [failed, setFailed] = useState(false);
  if (!asset.uploaded) return <p className="mt-3 text-sm text-[#747780]">Screenshot upload is incomplete.</p>;
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(asset.contentType.split(";")[0].toLowerCase()))
    return <p className="mt-3 text-sm text-[#747780]">This screenshot format is available from Evidence files.</p>;
  if (failed)
    return (
      <p role="alert" className="mt-3 text-sm text-[#a64235]">
        Screenshot unavailable. Check the upload or refresh your admin session.
      </p>
    );
  return (
    <a href={testRunAssetPath(runId, asset.assetId)} target="_blank" rel="noreferrer">
      <img
        src={testRunAssetPath(runId, asset.assetId)}
        alt={description}
        loading="lazy"
        onError={() => setFailed(true)}
        className="mt-4 max-h-80 rounded-xl border border-[#e0e4de] bg-[#f5f7f4]"
      />
    </a>
  );
}

function Outcome({ value, label }: { value: string; label?: string }) {
  const tone = ["passed", "ready", "complete"].includes(value)
    ? "bg-[#edf7f0] text-[#087d50]"
    : ["failed", "unavailable", "incomplete"].includes(value)
      ? "bg-[#fff0ed] text-[#a64235]"
      : "bg-[#f0f2ef] text-[#68746d]";
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none ${tone}`}>
      {label ? `${label}: ` : ""}
      {value.replaceAll("-", " ")}
    </span>
  );
}
function Filter({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-[#747780]">
      {label}
      {children}
    </label>
  );
}
function Loading({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-2 p-6 text-sm text-[#68746d]">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}
function Failure({ error }: { error: unknown }) {
  return (
    <div role="alert" className="flex items-start gap-2 p-6 text-sm text-[#a64235]">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <p>{error instanceof Error ? error.message : "Unable to load test results."}</p>
    </div>
  );
}
function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="p-8 text-center">
      <p className="font-semibold">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#747780]">{body}</p>
    </div>
  );
}
function date(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Not recorded"
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function short(value?: string) {
  return value ? value.slice(0, 12) : "Build not recorded";
}
function platformName(platform: string) {
  return platform === "ios-mac" ? "iOS on Mac" : platform === "ios" ? "iPhone" : "Android";
}
function time(seconds: number) {
  return Number.isFinite(seconds) && seconds >= 0
    ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`
    : "No timestamp";
}
function bytes(size: number) {
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(size / 1024)} KB`;
}
