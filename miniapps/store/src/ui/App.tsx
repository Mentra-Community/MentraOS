import {useCallback, useEffect, useMemo, useState} from "react"
import {useColorScheme, useSafeArea} from "@mentra/miniapp/ui"
import {
  MENTRA_STORE_PACKAGE_NAME,
  isManagedByStore,
  type InstalledApp,
  type StoreApp,
  type StoreSnapshot,
} from "../shared/types"
import {filterStoreCategory, isStoreActionDisabled, resolveSelectedApp, selectCompatibleUpdates} from "./model"
import arrowLeftIcon from "./assets/arrow-left.svg"
import shareIcon from "./assets/share.svg"

type Tab = "store" | "installed" | "updates"
type OperationPhase = NonNullable<StoreSnapshot["operation"]>["phase"]

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
  const [category, setCategory] = useState<string | null>(null)
  const [selectedPackageName, setSelectedPackageName] = useState<string | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)
  const [updatingAll, setUpdatingAll] = useState(false)
  const [shareMessage, setShareMessage] = useState<string | null>(null)
  const [changingTrack, setChangingTrack] = useState(false)

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
    () => selectCompatibleUpdates(snapshot.apps, installedByPackage),
    [snapshot.apps, installedByPackage],
  )
  const categories = useMemo(
    () => [...new Set(snapshot.apps.flatMap((app) => app.categories))].sort((a, b) => a.localeCompare(b)),
    [snapshot.apps],
  )
  const tabApps =
    tab === "installed"
      ? snapshot.apps.filter((app) => installedByPackage.has(app.packageName))
      : tab === "updates"
        ? updateApps
        : snapshot.apps
  const visible = filterStoreCategory(tabApps, category, query, tab === "store")
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
        return true
      } catch (error) {
        setSnapshot((current) => ({...current, error: error instanceof Error ? error.message : `${kind} failed`}))
        return false
      }
    },
    [query],
  )

  const updateAll = useCallback(async () => {
    setUpdatingAll(true)
    try {
      for (const app of updateApps) await run("install", app.packageName)
    } finally {
      setUpdatingAll(false)
    }
  }, [run, updateApps])

  const setReleaseTrack = useCallback(
    async (packageName: string, track: "stable" | "beta") => {
      setChangingTrack(true)
      try {
        const next = (await mentra.request("store:set-track", {packageName, track, query})) as StoreSnapshot
        setSnapshot(next)
      } catch (error) {
        setSnapshot((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "Could not change release track",
        }))
      } finally {
        setChangingTrack(false)
      }
    },
    [query],
  )

  const share = useCallback(async (app: StoreApp) => {
    const data = {
      title: app.name,
      text: `Check out ${app.name} in the Mentra Miniapp Store (${app.packageName}).`,
      ...(app.websiteUrl ? {url: app.websiteUrl} : {}),
    }
    try {
      if (navigator.share) {
        await navigator.share(data)
      } else {
        await navigator.clipboard.writeText([data.text, data.url].filter(Boolean).join(" "))
        setShareMessage("Miniapp link copied")
        window.setTimeout(() => setShareMessage(null), 2200)
      }
    } catch (error) {
      if ((error as {name?: string}).name !== "AbortError") {
        setShareMessage("Could not share this miniapp")
        window.setTimeout(() => setShareMessage(null), 2200)
      }
    }
  }, [])

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
          phase={snapshot.operation?.packageName === selected.packageName ? snapshot.operation.phase : undefined}
          onBack={() => setSelectedPackageName(null)}
          onAction={run}
          onShare={() => void share(selected)}
          onUninstall={() => setConfirmUninstall(selected.packageName)}
          changingTrack={changingTrack}
          onSetTrack={(track) => void setReleaseTrack(selected.packageName, track)}
        />
      ) : (
        <>
          <header className="topbar">
            <div>
              <div className="eyebrow">Mentra</div>
              <h1>Miniapp Store</h1>
            </div>
            <button
              className="refresh-button"
              aria-label="Refresh Store"
              onClick={() => void mentra.request("store:refresh", {query}).then(setSnapshot)}>
              Refresh
            </button>
          </header>

          <div className="search-wrap">
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

          {tab === "store" && !query.trim() && categories.length > 0 ? (
            <div className="category-list" aria-label="Store categories">
              <button className={category === null ? "active" : ""} onClick={() => setCategory(null)}>
                All
              </button>
              {categories.map((item) => (
                <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>
                  {item}
                </button>
              ))}
            </div>
          ) : null}

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
                <div className="state-icon" aria-hidden="true" />
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
                  {tab === "updates" && updateApps.length > 1 ? (
                    <button
                      className="update-all"
                      disabled={updatingAll || Boolean(snapshot.operation)}
                      onClick={() => void updateAll()}>
                      {updatingAll ? "Updating…" : "Update all"}
                    </button>
                  ) : null}
                </div>
                <div className="app-list">
                  {visible.map((app) => (
                    <AppRow
                      key={app.packageName}
                      app={app}
                      installed={installedByPackage.get(app.packageName)}
                      busy={snapshot.operation?.packageName === app.packageName}
                      disabled={Boolean(snapshot.operation)}
                      phase={snapshot.operation?.packageName === app.packageName ? snapshot.operation.phase : undefined}
                      onSelect={() => setSelectedPackageName(app.packageName)}
                      onAction={run}
                    />
                  ))}
                  {orphanedInstalled.map((installed) => (
                    <InstalledOnlyRow
                      key={installed.packageName}
                      installed={installed}
                      disabled={Boolean(snapshot.operation)}
                      onRequestUninstall={() => setConfirmUninstall(installed.packageName)}
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
                {item[0].toUpperCase() + item.slice(1)}
                {item === "updates" && updateApps.length ? ` (${updateApps.length})` : ""}
              </button>
            ))}
          </nav>
        </>
      )}
      {shareMessage ? (
        <div className="toast" role="status">
          {shareMessage}
        </div>
      ) : null}
      {confirmUninstall ? (
        <ConfirmDialog
          name={
            snapshot.apps.find((app) => app.packageName === confirmUninstall)?.name ??
            snapshot.installed.find((app) => app.packageName === confirmUninstall)?.name ??
            confirmUninstall
          }
          busy={snapshot.operation?.packageName === confirmUninstall}
          onCancel={() => setConfirmUninstall(null)}
          onConfirm={async () => {
            if (await run("uninstall", confirmUninstall)) {
              setConfirmUninstall(null)
              if (selectedPackageName === confirmUninstall) setSelectedPackageName(null)
            }
          }}
        />
      ) : null}
    </div>
  )
}

function InstalledOnlyRow({
  installed,
  disabled,
  onRequestUninstall,
  onAction,
}: {
  installed: InstalledApp
  disabled: boolean
  onRequestUninstall: () => void
  onAction: (kind: "install" | "uninstall" | "open", packageName: string) => Promise<boolean>
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
          disabled={disabled || installed.compatibility.isCompatible === false}
          onClick={() => void onAction("open", installed.packageName)}>
          Open
        </button>
        {!installed.system && isManagedByThisStore(installed) && (
          <button className="action danger-action" disabled={disabled} onClick={onRequestUninstall}>
            Uninstall
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
  disabled,
  phase,
  onSelect,
  onAction,
}: {
  app: StoreApp
  installed?: InstalledApp
  busy: boolean
  disabled: boolean
  phase?: OperationPhase
  onSelect: () => void
  onAction: (kind: "install" | "uninstall" | "open", packageName: string) => Promise<boolean>
}) {
  const update = Boolean(installed && isNewerVersion(app.release.version, installed.version))
  const action = !installed || update ? "install" : "open"
  const installBlocker = action === "install" && app.release.installCompatibility?.compatible === false
  const label = busy
    ? operationLabel(phase)
    : installBlocker
      ? app.release.installCompatibility?.blocker === "hardware"
        ? "Not compatible"
        : app.release.installCompatibility?.blocker === "host" || app.release.installCompatibility?.blocker === "sdk"
          ? "Requires update"
          : "Unavailable"
      : update
        ? "Update"
        : installed
          ? "Open"
          : "Get"
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
        disabled={disabled || isStoreActionDisabled(action, installed, app.release.installCompatibility)}
        title={installBlocker ? app.release.installCompatibility?.reason : undefined}
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
  phase,
  onBack,
  onAction,
  onShare,
  onUninstall,
  changingTrack,
  onSetTrack,
}: {
  app: StoreApp
  installed?: InstalledApp
  busy: boolean
  phase?: OperationPhase
  onBack: () => void
  onAction: (kind: "install" | "uninstall" | "open", packageName: string) => Promise<boolean>
  onShare: () => void
  onUninstall: () => void
  changingTrack: boolean
  onSetTrack: (track: "stable" | "beta") => void
}) {
  const update = Boolean(installed && isNewerVersion(app.release.version, installed.version))
  const kind = !installed || update ? "install" : "open"
  const installBlocker = kind === "install" && app.release.installCompatibility?.compatible === false
  const installBlockerKind = app.release.installCompatibility?.blocker
  const requiresHostUpdate = installBlockerKind === "host" || installBlockerKind === "sdk"
  const label = busy
    ? operationLabel(phase)
    : installBlocker
      ? installBlockerKind === "hardware"
        ? "Not compatible"
        : requiresHostUpdate
          ? "Requires Mentra App update"
          : "Unavailable"
      : update
        ? "Update"
        : installed
          ? "Open"
          : "Get"
  return (
    <div className="detail">
      <header className="detail-nav">
        <button onClick={onBack} aria-label="Back to Store">
          <img src={arrowLeftIcon} alt="" />
        </button>
      </header>
      <main>
        <section className="hero">
          <AppIcon app={app} />
          <div className="hero-copy">
            <h1>{app.name}</h1>
            <p>{app.categories.join(" · ") || "Mentra miniapp"}</p>
            <div className="hero-actions">
              <button
                className="action primary"
                disabled={busy || isStoreActionDisabled(kind, installed, app.release.installCompatibility)}
                onClick={() => void onAction(kind, app.packageName)}>
                {label}
              </button>
              <button className="share-action" onClick={onShare}>
                <img src={shareIcon} alt="" />
                Share
              </button>
            </div>
          </div>
        </section>
        {installed?.compatibility.isCompatible === false && (
          <div className="notice">This miniapp is not compatible with the connected glasses.</div>
        )}
        {installBlocker && installBlockerKind === "hardware" && (
          <div className="notice">{app.release.installCompatibility?.reason}</div>
        )}
        {installBlocker && requiresHostUpdate && (
          <div className="notice">
            {update
              ? "This update will install automatically after the Mentra App is updated. "
              : "Update the Mentra App to install this miniapp. "}
            {app.release.installCompatibility?.reason}
          </div>
        )}
        {installBlocker && !installBlockerKind && (
          <div className="notice">Compatibility could not be verified. {app.release.installCompatibility?.reason}</div>
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
          <Info label="Track" value={app.selectedTrack === "beta" ? "Beta" : "Stable"} />
          <Info label="Review" value={app.reviewTier === "verified" ? "Verified" : "Community"} />
          <Info label="Permissions" value={String(app.release.permissions.length)} />
          <Info label="Package" value={app.packageName} />
        </section>
        {(app.availableTracks.includes("beta") || app.preferredTrack === "beta") && (
          <section className="detail-section track-section">
            <div>
              <h2>Release track</h2>
              <p>
                {app.preferredTrack === "beta" && app.selectedTrack === "stable"
                  ? "You’re enrolled in beta. Stable is shown until the next beta release is available."
                  : app.preferredTrack === "beta"
                    ? "You’re a beta tester. Preview releases install automatically, and you can leave at any time."
                    : app.betaAccess === "invited"
                      ? "You’ve been invited to this private beta."
                      : "This developer offers a public beta with preview releases."}
              </p>
            </div>
            <div className="track-options" role="group" aria-label="Release track">
              {(["stable", "beta"] as const).map((track) => (
                <button
                  key={track}
                  className={app.preferredTrack === track ? "active" : ""}
                  disabled={changingTrack || app.preferredTrack === track || (track === "beta" && !app.availableTracks.includes("beta"))}
                  onClick={() => onSetTrack(track)}>
                  {track === "stable"
                    ? app.preferredTrack === "beta"
                      ? "Leave beta"
                      : "Stable"
                    : app.betaAccess === "invited"
                      ? "Join private beta"
                      : "Join public beta"}
                </button>
              ))}
            </div>
          </section>
        )}
        <section className="links">
          {app.privacyPolicyUrl && (
            <button onClick={() => window.open(app.privacyPolicyUrl!, "_blank")}>Privacy policy ↗</button>
          )}
          {app.supportUrl && <button onClick={() => window.open(app.supportUrl!, "_blank")}>Support ↗</button>}
          {installed && !installed.system && isManagedByThisStore(installed) && (
            <button className="danger" disabled={busy} onClick={onUninstall}>
              Uninstall
            </button>
          )}
        </section>
      </main>
    </div>
  )
}

function operationLabel(phase?: OperationPhase): string {
  return phase ? `${phase[0]?.toUpperCase()}${phase.slice(1)}…` : "Working…"
}

function ConfirmDialog({
  name,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => Promise<void>
}) {
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="uninstall-title"
        onClick={(event) => event.stopPropagation()}>
        <h2 id="uninstall-title">Uninstall {name}?</h2>
        <p>The miniapp and its local data will be removed from this device. You can install it again later.</p>
        <div>
          <button disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="danger" disabled={busy} onClick={() => void onConfirm()}>
            {busy ? "Uninstalling…" : "Uninstall"}
          </button>
        </div>
      </section>
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
