import {useState} from "react"
import {CartesianGrid, ComposedChart, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis} from "recharts"

import {EmptyState} from "../components/EmptyState"
import {SectionCard} from "../components/SectionCard"
import type {MonitorSnapshot} from "../types"
import {buildLatencySeries, formatClock, formatDelay} from "../utils"

const WINDOW_OPTIONS = [
  {label: "1m", value: 60_000, tickStepMs: 10_000},
  {label: "5m", value: 5 * 60_000, tickStepMs: 60_000},
  {label: "15m", value: 15 * 60_000, tickStepMs: 5 * 60_000},
  {label: "1h", value: 60 * 60_000, tickStepMs: 10 * 60_000},
  {label: "6h", value: 6 * 60 * 60_000, tickStepMs: 60 * 60_000},
  {label: "1d", value: 24 * 60 * 60_000, tickStepMs: 4 * 60 * 60_000},
  {label: "All", value: null, tickStepMs: null},
] as const

function alignUp(ms: number, stepMs: number): number {
  return Math.ceil(ms / stepMs) * stepMs
}

function buildWindowTicks(startMs: number, endMs: number, tickStepMs: number | null): number[] | undefined {
  if (!tickStepMs) {
    return undefined
  }

  const ticks: number[] = []
  for (let tickMs = alignUp(startMs, tickStepMs); tickMs <= endMs; tickMs += tickStepMs) {
    ticks.push(tickMs)
  }
  return ticks
}

function formatTimeTick(ms: number, windowMs: number | null): string {
  const options: Intl.DateTimeFormatOptions =
    windowMs !== null && windowMs <= 60_000
      ? {hour: "numeric", minute: "2-digit", second: "2-digit"}
      : {hour: "numeric", minute: "2-digit"}
  return new Date(ms).toLocaleTimeString([], options)
}

export function LatencyTab({snapshot}: {snapshot: MonitorSnapshot}) {
  const [windowMs, setWindowMs] = useState<number | null>(null)
  const latestPointTsMs = snapshot.logcat_true_word_delay_points.at(-1)?.ts_ms ?? null
  const activeWindow = WINDOW_OPTIONS.find((option) => option.value === windowMs) ?? WINDOW_OPTIONS.at(-1)
  const windowStartMs = windowMs !== null && latestPointTsMs !== null ? latestPointTsMs - windowMs : null
  const xDomain =
    windowMs !== null && latestPointTsMs !== null
      ? [latestPointTsMs - windowMs, latestPointTsMs]
      : (["dataMin", "dataMax"] as const)
  const ticks =
    windowStartMs !== null && latestPointTsMs !== null
      ? buildWindowTicks(windowStartMs, latestPointTsMs, activeWindow?.tickStepMs ?? null)
      : undefined
  const filteredPoints =
    windowMs === null || latestPointTsMs === null
      ? snapshot.logcat_true_word_delay_points
      : snapshot.logcat_true_word_delay_points.filter((point) => latestPointTsMs - point.ts_ms <= windowMs)
  const latencySeries = buildLatencySeries(filteredPoints)
  const activeWindowLabel = activeWindow?.label ?? "All"

  return (
    <div className="tab-layout">
      <SectionCard
        title="Latency Trend"
        subtitle={`Showing ${activeWindowLabel} of raw word visibility points with a 10-point trimmed moving average`}>
        <div className="latency-toolbar" role="group" aria-label="Latency time window">
          {WINDOW_OPTIONS.map((option) => (
            <button
              key={option.label}
              className="latency-window-button"
              data-active={option.value === windowMs ? "true" : "false"}
              onClick={() => setWindowMs(option.value)}
              type="button">
              {option.label}
            </button>
          ))}
          <span className="latency-window-meta">
            {filteredPoints.length} point{filteredPoints.length === 1 ? "" : "s"}
          </span>
        </div>
        {latencySeries.length ? (
          <div className="chart-shell">
            <ResponsiveContainer width="100%" height={380}>
              <ComposedChart data={latencySeries} margin={{top: 16, right: 16, left: 0, bottom: 16}}>
                <CartesianGrid stroke="rgba(140, 158, 189, 0.16)" vertical={false} />
                <XAxis
                  dataKey="ts_ms"
                  type="number"
                  allowDataOverflow={windowMs !== null}
                  domain={xDomain}
                  ticks={ticks}
                  tickFormatter={(value: number) => formatTimeTick(value, windowMs)}
                  minTickGap={36}
                  stroke="#7f90b2"
                />
                <YAxis
                  tickFormatter={(value: number) => `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}s`}
                  stroke="#7f90b2"
                  width={72}
                />
                <Tooltip
                  cursor={{stroke: "#33415f"}}
                  contentStyle={{background: "#101828", border: "1px solid #27324a", borderRadius: 12}}
                  formatter={(value: number) => formatDelay(value)}
                  labelFormatter={(value: number) => formatClock(value)}
                />
                <Scatter isAnimationActive={false} name="Raw delay" dataKey="delay_ms" fill="#79c7ff" />
                <Line
                  isAnimationActive={false}
                  type="monotone"
                  name="Trimmed avg"
                  dataKey="moving_average"
                  stroke="#ffaf45"
                  strokeWidth={3}
                  dot={false}
                  connectNulls={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EmptyState
            title="No latency data yet"
            detail="Word-level delay points will appear once captions are being matched."
          />
        )}
      </SectionCard>

      <div className="content-grid two-up">
        <SectionCard title="Recent Utterances" subtitle="Trimmed average delay per completed utterance">
          {snapshot.completed_utterances.length ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Trimmed Logcat True</th>
                  <th>Peak</th>
                </tr>
              </thead>
              <tbody>
                {[...snapshot.completed_utterances]
                  .reverse()
                  .slice(0, 20)
                  .map((utterance) => (
                    <tr key={`utterance-${utterance.dataset_row_idx}-${utterance.text}`}>
                      <td>{utterance.dataset_row_idx}</td>
                      <td>{formatDelay(utterance.average_logcat_true_delay_ms)}</td>
                      <td>{formatDelay(utterance.max_logcat_true_delay_ms)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              title="No completed utterances yet"
              detail="This fills in as the monitor finishes audio rows."
            />
          )}
        </SectionCard>

        <SectionCard title="Recent Word Matches" subtitle="Latest matched words from the live stream">
          {snapshot.word_delay_points.length ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Word</th>
                  <th>Delay</th>
                  <th>Expected</th>
                  <th>Seen</th>
                </tr>
              </thead>
              <tbody>
                {[...snapshot.word_delay_points]
                  .reverse()
                  .slice(0, 20)
                  .map((point) => (
                    <tr key={`${point.dataset_row_idx}-${point.word_index}-${point.ts_ms}`}>
                      <td>{point.word_text}</td>
                      <td>{formatDelay(point.delay_ms)}</td>
                      <td>{formatClock(point.expected_ts_ms)}</td>
                      <td>{formatClock(point.ts_ms)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              title="No word matches yet"
              detail="You will see individual matched words here once captions align with the dataset."
            />
          )}
        </SectionCard>
      </div>
    </div>
  )
}
