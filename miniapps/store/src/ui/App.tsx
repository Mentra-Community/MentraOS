import {useCallback, useEffect, useMemo, useState} from "react"
import {useColorScheme, useSafeArea} from "@mentra/miniapp/ui"
import {isNewerVersion} from "../background/catalog"
import {
  MENTRA_STORE_PACKAGE_NAME,
  isManagedByStore,
  type InstalledApp,
  type StoreApp,
  type StoreSnapshot,
} from "../shared/types"
import {isStoreActionDisabled, resolveSelectedApp} from "./model"

type Tab = "store" | "installed" | "updates"

function isManagedByThisStore(installed: InstalledApp): boolean {
  return isManagedByStore(installed, MENTRA_STORE_PACKAGE_NAME)
}

const EMPTY: StoreSnapshot = {
  apps: [],
  installed: [],
  loading: true,
  offline: false,
  error: null,
  operation: null,
  refreshedAt: null,
}

export function App() {
  const {insets} = useSafeArea()
  const colorScheme = useColorScheme()
  const [snapshot, setSnapshot] = useState(EMPTY)
  const [tab, setTab] = useState<Tab>("store")
  const [query, setQuery] = useState("")
  const [selectedPackageName, setSelectedPackageName] = useState<string | null>(null)

  useEffect(() => mentra.on("store:snapshot", setSnapshot), [])
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void mentra
        .request("store:refresh", {query})
        .then(setSnapshot)
        .catch(() => {})
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query])

  const installedByPackage = useMemo(
    () => new Map(snapshot.installed.map((app) => [app.packageName, app])),
    [snapshot.installed],
  )
  const selected = resolveSelectedApp(snapshot.apps, selectedPackageName)
  const updateApps = useMemo(
    () =>
      snapshot.apps.filter((app) => {
        const installed = installedByPackage.get(app.packageName)
        return installed && isNewerVersion(app.release.version, installed.version)
      }),
    [snapshot.apps, installedByPackage],
  )
  const visible =
    tab === "installed"
      ? snapshot.apps.filter((app) => installedByPackage.has(app.packageName))
      : tab === "updates"
        ? updateApps
        : snapshot.apps
  const orphanedInstalled =
    tab === "installed" && !query.trim()
      ? snapshot.installed.filter(
          (installed) => !snapshot.apps.some((app) => app.packageName === installed.packageName),
        )
      : []

  const run = useCallback(
    async (kind: "install" | "uninstall" | "open", packageName: string) => {
      try {
        const next = (await mentra.request(`store:${kind}`, {packageName, query})) as StoreSnapshot
        setSnapshot(next)
      } catch (error) {
        setSnapshot((current) => ({...current, error: error instanceof Error ? error.message : `${kind} failed`}))
      }
    },
    [query],
  )

  const style = {
    paddingTop: insets.top,
    paddingRight: insets.right,
    paddingBottom: insets.bottom,
    paddingLeft: insets.left,
  }

  return (
    <div className="app" data-theme={colorScheme} style={style}>
      {selected ? (
        <Detail
          app={selected}
          installed={installedByPackage.get(selected.packageName)}
          busy={snapshot.operation?.packageName === selected.packageName}
          onBack={() => setSelectedPackageName(null)}
          onAction={run}
        />
      ) : (
        <>
          <header className="topbar">
            <div>
              <div className="eyebrow">Mentra</div>
              <h1>Miniapp Store</h1>
            </div>
            <button
              className="icon-button"
              aria-label="Refresh Store"
              onClick={() => void mentra.request("store:refresh", {query}).then(setSnapshot)}>
              ↻
            </button>
          </header>

          <div className="search-wrap">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="Search miniapps"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search miniapps"
            />
            {query && (
              <button aria-label="Clear search" onClick={() => setQuery("")}>
                ×
              </button>
            )}
          </div>

          {snapshot.error && (
            <div className="notice" role="alert">
              <span>
                {snapshot.offline ? "You appear to be offline. " : ""}
                {snapshot.error}
              </span>
              <button onClick={() => void mentra.request("store:refresh", {query}).then(setSnapshot)}>Retry</button>
            </div>
          )}

          <main className="content">
            {snapshot.loading && snapshot.apps.length === 0 ? (
              <div className="state">
                <div className="spinner" />
                <h2>Loading Store…</h2>
              </div>
            ) : visible.length === 0 && orphanedInstalled.length === 0 ? (
              <div className="state">
                <div className="state-icon">◇</div>
                <h2>
                  {tab === "updates"
                    ? "You’re up to date"
                    : tab === "installed"
                      ? "No Store miniapps installed"
                      : "No miniapps found"}
                </h2>
                <p>
                  {tab === "store"
                    ? "Try another search or check your connection."
                    : "Browse the Store to discover something new."}
                </p>
              </div>
            ) : (
              <section>
                <div className="section-heading">
                  <h2>
                    {tab === "store"
                      ? query
                        ? "Search results"
                        : "Discover"
                      : tab === "installed"
                        ? "Installed"
                        : "Available updates"}
                  </h2>
                  <span>{visible.length}</span>
                </div>
                <div className="app-list">
                  {visible.map((app) => (
                    <AppRow
                      key={app.packageName}
                      app={app}
                      installed={installedByPackage.get(app.packageName)}
                      busy={Boolean(snapshot.operation)}
                      onSelect={() => setSelectedPackageName(app.packageName)}
                      onAction={run}
                    />
                  ))}
                  {orphanedInstalled.map((installed) => (
                    <InstalledOnlyRow
                      key={installed.packageName}
                      installed={installed}
                      busy={Boolean(snapshot.operation)}
                      onAction={run}
                    />
                  ))}
                </div>
              </section>
            )}
          </main>

          <nav className="tabs" aria-label="Store sections">
            {(["store", "installed", "updates"] as Tab[]).map((item) => (
              <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
                <span aria-hidden="true">{item === "store" ? "⌂" : item === "installed" ? "✓" : "↑"}</span>
                {item[0].toUpperCase() + item.slice(1)}
                {item === "updates" && updateApps.length ? ` (${updateApps.length})` : ""}
              </button>
            ))}
          </nav>
        </>
      )}
    </div>
  )
}

function InstalledOnlyRow({
  installed,
  busy,
  onAction,
}: {
  installed: InstalledApp
  busy: boolean
  onAction: (kind: "install" | "uninstall" | "open", packageName: string) => Promise<void>
}) {
  return (
    <article className="app-row">
      <span className="app-icon fallback" aria-hidden="true">
        {installed.name.slice(0, 1).toUpperCase()}
      </span>
      <span className="app-copy installed-only-copy">
        <strong>{installed.name}</strong>
        <span>{installed.packageName}</span>
        <small>No longer listed · version {installed.version}</small>
      </span>
      <div className="installed-actions">
        <button
          className="action"
          disabled={busy || installed.compatibility.isCompatible === false}
          onClick={() => void onAction("open", installed.packageName)}>
          Open
        </button>
        {isManagedByThisStore(installed) && (
          <button
            className="action danger-action"
            disabled={busy}
            onClick={() => void onAction("uninstall", installed.packageName)}>
            Remove
          </button>
        )}
      </div>
    </article>
  )
}

function AppRow({
  app,
  installed,
  busy,
  onSelect,
  onAction,
}: {
  app: StoreApp
  installed?: InstalledApp
  busy: boolean
  onSelect: () => void
  onAction: (kind: "install" | "uninstall" | "open", packageName: string) => Promise<void>
}) {
  const update = Boolean(installed && isNewerVersion(app.release.version, installed.version))
  const action = !installed || update ? "install" : "open"
  const label = busy ? "Working…" : update ? "Update" : installed ? "Open" : "Get"
  return (
    <article className="app-row">
      <button className="app-main" onClick={onSelect} aria-label={`View ${app.name}`}>
        <AppIcon app={app} />
        <span className="app-copy">
          <strong>{app.name}</strong>
          <span>{app.subtitle ?? app.categories[0] ?? "Mentra miniapp"}</span>
          {app.reviewTier === "verified" && <small>✓ Verified</small>}
        </span>
      </button>
      <button
        className="action"
        disabled={busy || isStoreActionDisabled(action, installed)}
        onClick={() => void onAction(action, app.packageName)}>
        {label}
      </button>
    </article>
  )
}

function AppIcon({app}: {app: StoreApp}) {
  return app.iconUrl ? (
    <img className="app-icon" src={app.iconUrl} alt="" />
  ) : (
    <span className="app-icon fallback" aria-hidden="true">
      {app.name.slice(0, 1).toUpperCase()}
    </span>
  )
}

function Detail({
  app,
  installed,
  busy,
  onBack,
  onAction,
}: {
  app: StoreApp
  installed?: InstalledApp
  busy: boolean
  onBack: () => void
  onAction: (kind: "install" | "uninstall" | "open", packageName: string) => Promise<void>
}) {
  const update = Boolean(installed && isNewerVersion(app.release.version, installed.version))
  const kind = !installed || update ? "install" : "open"
  const label = busy ? "Working…" : update ? "Update" : installed ? "Open" : "Get"
  return (
    <div className="detail">
      <header className="detail-nav">
        <button onClick={onBack} aria-label="Back to Store">
          ‹
        </button>
        <span>Miniapp details</span>
        <span className="nav-space" />
      </header>
      <main>
        <section className="hero">
          <AppIcon app={app} />
          <div>
            <h1>{app.name}</h1>
            <p>{app.categories.join(" · ") || "Mentra miniapp"}</p>
          </div>
          <button
            className="action primary"
            disabled={busy || isStoreActionDisabled(kind, installed)}
            onClick={() => void onAction(kind, app.packageName)}>
            {label}
          </button>
        </section>
        {installed?.compatibility.isCompatible === false && (
          <div className="notice">This miniapp is not compatible with the connected glasses.</div>
        )}
        <section className="detail-section">
          <h2>About</h2>
          <p>{app.description ?? app.subtitle ?? "No description provided."}</p>
        </section>
        {app.screenshotUrls.length > 0 && (
          <section className="detail-section">
            <h2>Preview</h2>
            <div className="screenshots">
              {app.screenshotUrls.map((url) => (
                <img key={url} src={url} alt={`${app.name} screenshot`} />
              ))}
            </div>
          </section>
        )}
        <section className="detail-section info-grid">
          <Info label="Version" value={app.release.version} />
          <Info label="Review" value={app.reviewTier === "verified" ? "Verified" : "Community"} />
          <Info label="Permissions" value={String(app.release.permissions.length)} />
          <Info label="Package" value={app.packageName} />
        </section>
        <section className="links">
          {app.privacyPolicyUrl && (
            <button onClick={() => window.open(app.privacyPolicyUrl!, "_blank")}>Privacy policy ↗</button>
          )}
          {app.supportUrl && <button onClick={() => window.open(app.supportUrl!, "_blank")}>Support ↗</button>}
          {installed && isManagedByThisStore(installed) && (
            <button className="danger" disabled={busy} onClick={() => void onAction("uninstall", app.packageName)}>
              Uninstall
            </button>
          )}
        </section>
      </main>
    </div>
  )
}

function Info({label, value}: {label: string; value: string}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
