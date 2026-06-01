import * as Tabs from "@radix-ui/react-tabs"
import {lazy, startTransition, Suspense, useEffect, useMemo, useState} from "react"

import {EmptyState} from "./components/EmptyState"
import {MetricCard} from "./components/MetricCard"
import {RelativeAge} from "./components/RelativeAge"
import {SectionCard} from "./components/SectionCard"
import {StatusBadge} from "./components/StatusBadge"
import type {CurrentUtterance, DelayPoint, MonitorSnapshot} from "./types"
import {formatClockWithMs, formatEndpointLabel} from "./utils"

const OverviewTab = lazy(() => import("./tabs/OverviewTab").then((module) => ({default: module.OverviewTab})))
const IncidentsTab = lazy(() => import("./tabs/IncidentsTab").then((module) => ({default: module.IncidentsTab})))
const AlertsTab = lazy(() => import("./tabs/AlertsTab").then((module) => ({default: module.AlertsTab})))
const LatencyTab = lazy(() => import("./tabs/LatencyTab").then((module) => ({default: module.LatencyTab})))
const DebugTab = lazy(() => import("./tabs/DebugTab").then((module) => ({default: module.DebugTab})))

const FALLBACK_REFRESH_MS = 60_000
const LATENCY_CHART_POINT_LIMIT = 4_000
const RECENT_WORD_MATCH_LIMIT = 200
const COMPLETED_UTTERANCE_LIMIT = 120
const RESYNC_DELAY_MS = 100
const LATENCY_RESYNC_DELAY_MS = 250
const TAB_OPTIONS = [
  {value: "overview", label: "Overview"},
  {value: "incidents", label: "Incidents"},
  {value: "alerts", label: "Alerts"},
  {value: "latency", label: "Latency"},
  {value: "debug", label: "Debug"},
] as const
const STREAM_EVENT_NAMES = [
  "status_changed",
  "visible_lines_updated",
  "word_match",
  "utterance_started",
  "utterance_completed",
  "incident_started",
  "incident_ended",
  "incident_promoted",
  "incident_alerted",
  "alert_updated",
  "drop_event",
  "error",
] as const

type TabValue = (typeof TAB_OPTIONS)[number]["value"]
type ViewMode = "single" | "compare"
type MonitorStreamEvent = {
  type: (typeof STREAM_EVENT_NAMES)[number] | string
  payload: Record<string, unknown>
}
interface DashboardRouteState {
  activeTab: TabValue
  viewMode: ViewMode
  selectedDevice: string | null
}
interface RenderActiveTabOptions {
  compareDevice?: boolean
}

const DEFAULT_TAB_VALUE: TabValue = "overview"
const DEFAULT_VIEW_MODE: ViewMode = "compare"

function isTabValue(value: string | null): value is TabValue {
  return TAB_OPTIONS.some((tab) => tab.value === value)
}

function isViewMode(value: string | null): value is ViewMode {
  return value === "single" || value === "compare"
}

function readDashboardRouteState(): DashboardRouteState {
  const params = new URLSearchParams(window.location.search)
  const tab = params.get("tab")
  const view = params.get("view")
  const device = params.get("device")

  return {
    activeTab: isTabValue(tab) ? tab : DEFAULT_TAB_VALUE,
    viewMode: isViewMode(view) ? view : DEFAULT_VIEW_MODE,
    selectedDevice: device || null,
  }
}

function writeDashboardRouteState(activeTab: TabValue, viewMode: ViewMode, selectedDevice: string | null) {
  const params = new URLSearchParams(window.location.search)
  params.set("tab", activeTab)
  params.set("view", viewMode)

  if (viewMode === "single" && selectedDevice) {
    params.set("device", selectedDevice)
  } else {
    params.delete("device")
  }

  const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`
  if (nextUrl !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(null, "", nextUrl)
  }
}

function renderActiveTab(activeTab: TabValue, snapshot: MonitorSnapshot, options: RenderActiveTabOptions = {}) {
  switch (activeTab) {
    case "overview":
      return <OverviewTab compareDevice={options.compareDevice} snapshot={snapshot} />
    case "incidents":
      return <IncidentsTab snapshot={snapshot} />
    case "alerts":
      return <AlertsTab snapshot={snapshot} />
    case "latency":
      return <LatencyTab snapshot={snapshot} />
    case "debug":
      return <DebugTab compareDevice={options.compareDevice} snapshot={snapshot} />
  }
}

function CompareMonitorSummary({
  latestLogcatEventTsMs,
  snapshot,
}: {
  latestLogcatEventTsMs: number | null
  snapshot: MonitorSnapshot
}) {
  const utterance = snapshot.current_utterance

  return (
    <div className="compare-monitor-summary">
      <SectionCard title="Shared Monitor" subtitle="Global playback and collector state shared by every phone">
        <div className="metric-grid compare-monitor-grid">
          <MetricCard
            label="Monitor Status"
            value={<StatusBadge status={snapshot.status} />}
            detail={snapshot.status_detail || "Live monitor health"}
          />
          <MetricCard
            label="Current Row"
            value={utterance ? `#${utterance.dataset_row_idx}` : "-"}
            detail={utterance ? `${utterance.word_count} words in flight` : "Waiting for the next utterance"}
          />
          <MetricCard
            label="Latest Logcat Event"
            value={<RelativeAge ms={latestLogcatEventTsMs} emptyLabel="Waiting for event" />}
            detail="Freshest device update in compare mode"
          />
          <MetricCard
            label="Last Error"
            value={snapshot.last_error ? "Error" : "None"}
            detail={snapshot.last_error || "Collector is healthy"}
          />
        </div>
        <div className="compare-monitor-utterance">
          <span>Reference utterance</span>
          <strong>{utterance?.text || "No utterance is active right now."}</strong>
          <span>
            {utterance
              ? `${formatClockWithMs(utterance.start_ts_ms)} to ${formatClockWithMs(utterance.end_ts_ms)}`
              : "Waiting for playback"}
          </span>
        </div>
      </SectionCard>
    </div>
  )
}

function trimHistory<T>(items: T[], maxItems: number): T[] {
  if (items.length <= maxItems) {
    return items
  }
  return items.slice(items.length - maxItems)
}

function parseStreamEvent(event: MessageEvent<string>): MonitorStreamEvent | null {
  try {
    return {
      type: event.type,
      payload: JSON.parse(event.data) as Record<string, unknown>,
    }
  } catch {
    return null
  }
}

function patchCurrentUtterance(
  currentUtterance: CurrentUtterance | null | undefined,
  point: DelayPoint,
): CurrentUtterance | null | undefined {
  if (!currentUtterance || currentUtterance.dataset_row_idx !== point.dataset_row_idx) {
    return currentUtterance
  }
  const currentWord = currentUtterance.words[point.word_index]
  if (!currentWord) {
    return currentUtterance
  }

  const nextWords = [...currentUtterance.words]
  const nextWord = {...currentWord}
  let nextRnMatchedWordCount = currentUtterance.rn_matched_word_count

  if (point.source === "rn") {
    if (!nextWord.rn_first_visible_ts_ms) {
      nextRnMatchedWordCount += 1
    }
    nextWord.rn_first_visible_ts_ms = point.ts_ms
  } else if (point.source === "rn_true") {
    nextWord.rn_true_first_visible_ts_ms = point.ts_ms
  } else if (point.source === "logcat_true") {
    nextWord.logcat_true_first_visible_ts_ms = point.ts_ms
  }

  nextWords[point.word_index] = nextWord
  return {
    ...currentUtterance,
    rn_matched_word_count: nextRnMatchedWordCount,
    words: nextWords,
  }
}

function applyStreamUpdate(
  snapshot: MonitorSnapshot,
  streamEvent: MonitorStreamEvent,
  activeTab: TabValue,
): MonitorSnapshot {
  if (streamEvent.type === "status_changed") {
    return {
      ...snapshot,
      status: typeof streamEvent.payload.status === "string" ? streamEvent.payload.status : snapshot.status,
      status_detail:
        typeof streamEvent.payload.status_detail === "string"
          ? streamEvent.payload.status_detail
          : snapshot.status_detail,
      last_error:
        typeof streamEvent.payload.last_error === "string"
          ? streamEvent.payload.last_error
          : streamEvent.payload.last_error === null
            ? null
            : snapshot.last_error,
    }
  }

  if (streamEvent.type === "visible_lines_updated") {
    return {
      ...snapshot,
      logcat_visible_lines: Array.isArray(streamEvent.payload.visible_lines)
        ? streamEvent.payload.visible_lines.filter((value): value is string => typeof value === "string")
        : snapshot.logcat_visible_lines,
      last_logcat_event_ts_ms:
        typeof streamEvent.payload.last_logcat_event_ts_ms === "number"
          ? streamEvent.payload.last_logcat_event_ts_ms
          : snapshot.last_logcat_event_ts_ms,
    }
  }

  if (streamEvent.type === "word_match") {
    const point = streamEvent.payload as unknown as DelayPoint
    const nextSnapshot: MonitorSnapshot = {
      ...snapshot,
      current_utterance: patchCurrentUtterance(snapshot.current_utterance, point),
    }

    if (activeTab !== "latency") {
      return nextSnapshot
    }

    return {
      ...nextSnapshot,
      word_delay_points: trimHistory([...snapshot.word_delay_points, point], RECENT_WORD_MATCH_LIMIT),
      logcat_true_word_delay_points:
        point.source === "logcat_true"
          ? trimHistory([...snapshot.logcat_true_word_delay_points, point], LATENCY_CHART_POINT_LIMIT)
          : snapshot.logcat_true_word_delay_points,
    }
  }

  if (activeTab === "latency" && streamEvent.type === "utterance_completed") {
    return {
      ...snapshot,
      current_utterance: null,
      completed_utterances: trimHistory(
        [...snapshot.completed_utterances, streamEvent.payload as unknown as MonitorSnapshot["completed_utterances"][number]],
        COMPLETED_UTTERANCE_LIMIT,
      ),
    }
  }

  return snapshot
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabValue>(() => readDashboardRouteState().activeTab)
  const [viewMode, setViewMode] = useState<ViewMode>(() => readDashboardRouteState().viewMode)
  const [selectedDevice, setSelectedDevice] = useState<string | null>(() => readDashboardRouteState().selectedDevice)
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null)
  const [compareSnapshots, setCompareSnapshots] = useState<Record<string, MonitorSnapshot>>({})
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    const handlePopState = () => {
      const nextRouteState = readDashboardRouteState()
      startTransition(() => {
        setActiveTab(nextRouteState.activeTab)
        setViewMode(nextRouteState.viewMode)
        setSelectedDevice(nextRouteState.selectedDevice)
      })
    }

    window.addEventListener("popstate", handlePopState)
    return () => {
      window.removeEventListener("popstate", handlePopState)
    }
  }, [])

  useEffect(() => {
    writeDashboardRouteState(activeTab, viewMode, selectedDevice)
  }, [activeTab, selectedDevice, viewMode])

  useEffect(() => {
    let cancelled = false
    let refreshInFlight = false
    let resyncTimeoutId: number | null = null

    const fetchSnapshot = async (deviceId: string | null) => {
      const params = new URLSearchParams({tab: activeTab})
      if (deviceId) {
        params.set("device", deviceId)
      }
      const response = await fetch(`/state?${params.toString()}`, {cache: "no-store"})
      if (!response.ok) {
        throw new Error(`State request failed with ${response.status}`)
      }
      return (await response.json()) as MonitorSnapshot
    }

    const refresh = async () => {
      if (refreshInFlight) {
        return
      }
      refreshInFlight = true
      try {
        const nextSnapshot = await fetchSnapshot(selectedDevice)
        if (cancelled) {
          return
        }
        const shouldCompare = viewMode === "compare" && nextSnapshot.devices.length > 1
        const nextCompareSnapshots = shouldCompare
          ? Object.fromEntries(
              await Promise.all(
                nextSnapshot.devices.map(
                  async (device) => [device.device_id, await fetchSnapshot(device.device_id)] as const,
                ),
              ),
            )
          : {}
        if (cancelled) {
          return
        }
        startTransition(() => {
          setSelectedDevice((currentDevice) => {
            if (currentDevice && nextSnapshot.devices.some((device) => device.device_id === currentDevice)) {
              return currentDevice
            }
            return nextSnapshot.selected_device_id
          })
          setSnapshot(nextSnapshot)
          setCompareSnapshots(nextCompareSnapshots)
          setErrorMessage(null)
        })
      } catch (error) {
        if (cancelled) {
          return
        }
        setErrorMessage(error instanceof Error ? error.message : String(error))
      } finally {
        refreshInFlight = false
      }
    }

    const scheduleResync = () => {
      if (cancelled || resyncTimeoutId !== null) {
        return
      }
      resyncTimeoutId = window.setTimeout(
        () => {
          resyncTimeoutId = null
          void refresh()
        },
        activeTab === "latency" ? LATENCY_RESYNC_DELAY_MS : RESYNC_DELAY_MS,
      )
    }

    const handleStreamEvent = (browserEvent: MessageEvent<string>) => {
      const streamEvent = parseStreamEvent(browserEvent)
      if (!streamEvent) {
        scheduleResync()
        return
      }
      const eventDeviceId = typeof streamEvent.payload.device_id === "string" ? streamEvent.payload.device_id : null
      if (viewMode === "single" && eventDeviceId && selectedDevice && eventDeviceId !== selectedDevice) {
        return
      }

      if (
        streamEvent.type === "status_changed" ||
        streamEvent.type === "visible_lines_updated" ||
        streamEvent.type === "word_match"
      ) {
        startTransition(() => {
          setSnapshot((currentSnapshot) => {
            if (!currentSnapshot) {
              return currentSnapshot
            }
            if (eventDeviceId && currentSnapshot.selected_device_id !== eventDeviceId) {
              return currentSnapshot
            }
            return applyStreamUpdate(currentSnapshot, streamEvent, activeTab)
          })
          if (viewMode === "compare") {
            setCompareSnapshots((currentCompareSnapshots) => {
              if (streamEvent.type === "status_changed") {
                return Object.fromEntries(
                  Object.entries(currentCompareSnapshots).map(([deviceId, deviceSnapshot]) => [
                    deviceId,
                    applyStreamUpdate(deviceSnapshot, streamEvent, activeTab),
                  ]),
                )
              }
              if (!eventDeviceId || !currentCompareSnapshots[eventDeviceId]) {
                return currentCompareSnapshots
              }
              return {
                ...currentCompareSnapshots,
                [eventDeviceId]: applyStreamUpdate(currentCompareSnapshots[eventDeviceId], streamEvent, activeTab),
              }
            })
          }
          setErrorMessage(null)
        })
        return
      }

      if (streamEvent.type === "utterance_completed" && activeTab === "latency") {
        startTransition(() => {
          setSnapshot((currentSnapshot) => {
            if (!currentSnapshot) {
              return currentSnapshot
            }
            if (eventDeviceId && currentSnapshot.selected_device_id !== eventDeviceId) {
              return currentSnapshot
            }
            return applyStreamUpdate(currentSnapshot, streamEvent, activeTab)
          })
          if (viewMode === "compare" && eventDeviceId) {
            setCompareSnapshots((currentCompareSnapshots) =>
              currentCompareSnapshots[eventDeviceId]
                ? {
                    ...currentCompareSnapshots,
                    [eventDeviceId]: applyStreamUpdate(currentCompareSnapshots[eventDeviceId], streamEvent, activeTab),
                  }
                : currentCompareSnapshots,
            )
          }
          setErrorMessage(null)
        })
      }

      scheduleResync()
    }

    void refresh()

    const eventSource = new EventSource("/events")
    for (const eventName of STREAM_EVENT_NAMES) {
      eventSource.addEventListener(eventName, handleStreamEvent as EventListener)
    }
    eventSource.onerror = () => {
      scheduleResync()
    }

    const fallbackIntervalId = window.setInterval(() => {
      void refresh()
    }, FALLBACK_REFRESH_MS)

    return () => {
      cancelled = true
      if (resyncTimeoutId !== null) {
        window.clearTimeout(resyncTimeoutId)
      }
      window.clearInterval(fallbackIntervalId)
      for (const eventName of STREAM_EVENT_NAMES) {
        eventSource.removeEventListener(eventName, handleStreamEvent as EventListener)
      }
      eventSource.close()
    }
  }, [activeTab, selectedDevice, viewMode])

  const effectiveViewMode: ViewMode =
    snapshot && snapshot.devices.length > 1 && viewMode === "compare" ? "compare" : "single"

  const headline = useMemo(() => {
    if (!snapshot) {
      return "Loading monitor dashboard"
    }

    const activeIncidentCount =
      effectiveViewMode === "compare"
        ? snapshot.devices.reduce((total, device) => {
            const compareSnapshot = compareSnapshots[device.device_id]
            return total + (compareSnapshot?.ongoing_incidents.length ?? device.ongoing_incident_count)
          }, 0)
        : snapshot.ongoing_incidents.length

    return activeIncidentCount
      ? `${activeIncidentCount} active incident${activeIncidentCount === 1 ? "" : "s"}`
      : "No active incidents"
  }, [compareSnapshots, effectiveViewMode, snapshot])

  const heroLogcatEventTsMs = useMemo(() => {
    if (!snapshot || effectiveViewMode === "single") {
      return snapshot?.last_logcat_event_ts_ms ?? null
    }

    return snapshot.devices.reduce<number | null>((latestTsMs, device) => {
      const deviceLogcatEventTsMs =
        compareSnapshots[device.device_id]?.last_logcat_event_ts_ms ?? device.last_logcat_event_ts_ms ?? null
      if (deviceLogcatEventTsMs === null) {
        return latestTsMs
      }
      if (latestTsMs === null || deviceLogcatEventTsMs > latestTsMs) {
        return deviceLogcatEventTsMs
      }
      return latestTsMs
    }, null)
  }, [compareSnapshots, effectiveViewMode, snapshot])

  return (
    <div className={`app-shell${effectiveViewMode === "compare" ? " compare-mode" : ""}`}>
      <div className="hero">
        <div className="hero-copy">
          <div className="eyebrow">MentraOS</div>
          <h1>Captions Monitor</h1>
          <p>Live e2e caption health across devices and backend targets.</p>
        </div>
        <div className="hero-status">
          <div className="hero-status-main">
            <div className="hero-pill">{snapshot ? <StatusBadge status={snapshot.status} /> : "Loading..."}</div>
            <strong>{headline}</strong>
          </div>
          {snapshot?.devices.length ? (
            <span>
              {effectiveViewMode === "compare" ? (
                <>
                  Comparing <strong>{snapshot.devices.length}</strong> devices
                </>
              ) : (
                <>
                  Device{" "}
                  <strong>
                    {snapshot.devices.find((device) => device.device_id === snapshot.selected_device_id)?.label ||
                      snapshot.selected_device_id}
                  </strong>
                </>
              )}
            </span>
          ) : null}
          {effectiveViewMode === "single" && snapshot?.backend_url ? (
            <span>
              Backend <strong>{formatEndpointLabel(snapshot.backend_url)}</strong>
            </span>
          ) : null}
          <span>
            {snapshot ? (
              <RelativeAge
                ms={heroLogcatEventTsMs}
                prefix={effectiveViewMode === "compare" ? "Latest logcat event " : "Last logcat event "}
                emptyLabel="Waiting for event"
              />
            ) : (
              "Waiting for initial state"
            )}
          </span>
          {errorMessage ? <span className="hero-error">{errorMessage}</span> : null}
        </div>
      </div>

      {!snapshot ? (
        <div className="loading-shell">
          <EmptyState
            title="Loading monitor state"
            detail={errorMessage || "Fetching initial snapshot and opening event stream."}
          />
        </div>
      ) : (
        <Tabs.Root
          className="tabs-root"
          value={activeTab}
          onValueChange={(value) => {
            if (isTabValue(value)) {
              setActiveTab(value)
            }
          }}>
          {snapshot.devices.length > 1 ? (
            <div className="dashboard-toolbar">
              <div className="view-mode-toggle" role="group" aria-label="Dashboard view mode">
                <button
                  aria-pressed={effectiveViewMode === "single"}
                  className={`view-mode-trigger${effectiveViewMode === "single" ? " active" : ""}`}
                  onClick={() => setViewMode("single")}
                  type="button">
                  Single
                </button>
                <button
                  aria-pressed={effectiveViewMode === "compare"}
                  className={`view-mode-trigger${effectiveViewMode === "compare" ? " active" : ""}`}
                  onClick={() => setViewMode("compare")}
                  type="button">
                  Compare
                </button>
              </div>
              {effectiveViewMode === "single" ? (
                <div className="device-switcher">
                  {snapshot.devices.map((device) => (
                    <button
                      key={device.device_id}
                      aria-pressed={snapshot.selected_device_id === device.device_id}
                      className={`device-trigger${snapshot.selected_device_id === device.device_id ? " active" : ""}`}
                      onClick={() => setSelectedDevice(device.device_id)}
                      type="button">
                      {device.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <Tabs.List className="tabs-list" aria-label="Monitor dashboard sections">
            {TAB_OPTIONS.map((tab) => (
              <Tabs.Trigger key={tab.value} className="tab-trigger" value={tab.value}>
                {tab.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          <Tabs.Content className="tab-content" forceMount value={activeTab}>
            <Suspense fallback={<div className="panel-loading">Loading {activeTab}…</div>}>
              {effectiveViewMode === "compare" ? (
                <div className="compare-layout">
                  <CompareMonitorSummary latestLogcatEventTsMs={heroLogcatEventTsMs} snapshot={snapshot} />
                  <div
                    className="compare-grid"
                    style={{gridTemplateColumns: `repeat(${Math.max(snapshot.devices.length, 1)}, minmax(0, 1fr))`}}>
                    {snapshot.devices.map((device) => {
                      const deviceSnapshot = compareSnapshots[device.device_id]
                      const lastLogcatEventTsMs =
                        deviceSnapshot?.last_logcat_event_ts_ms ?? device.last_logcat_event_ts_ms
                      return (
                        <section key={device.device_id} className="compare-panel">
                          <header className="compare-panel-header">
                            <div className="compare-panel-summary">
                              <strong>{device.label}</strong>
                              <div className="compare-panel-meta">
                                {deviceSnapshot?.backend_url ? (
                                  <span className="compare-panel-meta-item">
                                    <span className="compare-panel-meta-label">Backend</span>
                                    <strong>{formatEndpointLabel(deviceSnapshot.backend_url)}</strong>
                                  </span>
                                ) : null}
                                <span className="compare-panel-meta-item">
                                  <span className="compare-panel-meta-label">Last event</span>
                                  <RelativeAge ms={lastLogcatEventTsMs} emptyLabel="Waiting for event" />
                                </span>
                              </div>
                            </div>
                          </header>
                          {deviceSnapshot ? (
                            renderActiveTab(activeTab, deviceSnapshot, {compareDevice: true})
                          ) : (
                            <div className="panel-loading">Loading device…</div>
                          )}
                        </section>
                      )
                    })}
                  </div>
                </div>
              ) : (
                renderActiveTab(activeTab, snapshot)
              )}
            </Suspense>
          </Tabs.Content>
        </Tabs.Root>
      )}
    </div>
  )
}
