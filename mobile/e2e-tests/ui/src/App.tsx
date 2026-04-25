import * as Tabs from "@radix-ui/react-tabs"
import {lazy, startTransition, Suspense, useEffect, useMemo, useState} from "react"

import {EmptyState} from "./components/EmptyState"
import {StatusBadge} from "./components/StatusBadge"
import type {MonitorSnapshot} from "./types"
import {formatAge} from "./utils"

const OverviewTab = lazy(() => import("./tabs/OverviewTab").then((module) => ({default: module.OverviewTab})))
const IncidentsTab = lazy(() => import("./tabs/IncidentsTab").then((module) => ({default: module.IncidentsTab})))
const AlertsTab = lazy(() => import("./tabs/AlertsTab").then((module) => ({default: module.AlertsTab})))
const LatencyTab = lazy(() => import("./tabs/LatencyTab").then((module) => ({default: module.LatencyTab})))
const DebugTab = lazy(() => import("./tabs/DebugTab").then((module) => ({default: module.DebugTab})))

const POLL_INTERVAL_MS = 1000
const TAB_OPTIONS = [
  {value: "overview", label: "Overview"},
  {value: "incidents", label: "Incidents"},
  {value: "alerts", label: "Alerts"},
  {value: "latency", label: "Latency"},
  {value: "debug", label: "Debug"},
] as const

type TabValue = (typeof TAB_OPTIONS)[number]["value"]

export default function App() {
  const [activeTab, setActiveTab] = useState<TabValue>("overview")
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const refresh = async () => {
      try {
        const response = await fetch("/state", {cache: "no-store"})
        if (!response.ok) {
          throw new Error(`State request failed with ${response.status}`)
        }
        const nextSnapshot = (await response.json()) as MonitorSnapshot
        if (cancelled) {
          return
        }
        startTransition(() => {
          setSnapshot(nextSnapshot)
          setErrorMessage(null)
        })
      } catch (error) {
        if (cancelled) {
          return
        }
        setErrorMessage(error instanceof Error ? error.message : String(error))
      }
    }

    void refresh()
    const intervalId = window.setInterval(() => {
      void refresh()
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [])

  const headline = useMemo(() => {
    if (!snapshot) {
      return "Loading monitor dashboard"
    }
    return snapshot.ongoing_incidents.length
      ? `${snapshot.ongoing_incidents.length} active incident${snapshot.ongoing_incidents.length === 1 ? "" : "s"}`
      : "No active incidents"
  }, [snapshot])

  return (
    <div className="app-shell">
      <div className="hero">
        <div className="hero-copy">
          <div className="eyebrow">MentraOS Captions Monitor</div>
          <h1>Captions incident review dashboard.</h1>
          <p>
            Monitor caption health, incident state, alerts, latency, and recent debug signals during live or archived
            test runs.
          </p>
        </div>
        <div className="hero-status">
          <div className="hero-pill">{snapshot ? <StatusBadge status={snapshot.status} /> : "Loading…"}</div>
          <strong>{headline}</strong>
          <span>
            {snapshot ? `Last logcat event ${formatAge(snapshot.last_logcat_event_ts_ms)}` : "Waiting for state"}
          </span>
          {errorMessage ? <span className="hero-error">{errorMessage}</span> : null}
        </div>
      </div>

      {!snapshot ? (
        <div className="loading-shell">
          <EmptyState title="Loading monitor state" detail={errorMessage || "Polling /state once per second."} />
        </div>
      ) : (
        <Tabs.Root className="tabs-root" value={activeTab} onValueChange={(value) => setActiveTab(value as TabValue)}>
          <Tabs.List className="tabs-list" aria-label="Monitor dashboard sections">
            {TAB_OPTIONS.map((tab) => (
              <Tabs.Trigger key={tab.value} className="tab-trigger" value={tab.value}>
                {tab.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          {TAB_OPTIONS.map((tab) => (
            <Tabs.Content key={tab.value} className="tab-content" value={tab.value}>
              <Suspense fallback={<div className="panel-loading">Loading {tab.label.toLowerCase()}…</div>}>
                {tab.value === "overview" ? <OverviewTab snapshot={snapshot} /> : null}
                {tab.value === "incidents" ? <IncidentsTab snapshot={snapshot} /> : null}
                {tab.value === "alerts" ? <AlertsTab snapshot={snapshot} /> : null}
                {tab.value === "latency" ? <LatencyTab snapshot={snapshot} /> : null}
                {tab.value === "debug" ? <DebugTab snapshot={snapshot} /> : null}
              </Suspense>
            </Tabs.Content>
          ))}
        </Tabs.Root>
      )}
    </div>
  )
}
