import {createHash} from "node:crypto"
import {artifactUrl} from "./release-artifact-storage.mjs"

const escape = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

export const iosInstallUrl = (manifestUrl) =>
  `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`

export function macInstallPageUrl(pageUrl, attempt) {
  const url = new URL(pageUrl)
  if (url.protocol !== "https:" || !Number.isSafeInteger(attempt) || attempt <= 0)
    throw new Error("Invalid Mac installation handoff")
  url.searchParams.set("platform", "mac")
  url.searchParams.set("attempt", String(attempt))
  return url.href
}

// Fixed code only. The receipt supplies validated coordinates through HTML data
// attributes; the public receipt attempt travels in the HTTPS handoff query so
// the immutable page remains identical when publication is retried.
const macInstallScript = `(() => {
  const query = new URLSearchParams(window.location.search);
  if (query.getAll("platform").length !== 1 || query.get("platform") !== "mac") return;
  const section = document.getElementById("mac-install");
  section.hidden = false;
  document.getElementById("iphone-install").hidden = true;
  document.getElementById("install-heading").textContent = "Install Mentra on Mac";
  const status = document.getElementById("mac-status");
  const attempts = query.getAll("attempt");
  if (attempts.length !== 1 || !/^[1-9][0-9]*$/.test(attempts[0]) || !Number.isSafeInteger(Number(attempts[0]))) {
    status.textContent = "Open the Install on Mac link in #pr-builds to select the published build. For first-time setup, download the installer below.";
    return;
  }
  const target = new URL("mentra-install://pr");
  target.searchParams.set("number", section.dataset.number);
  target.searchParams.set("head", section.dataset.head);
  target.searchParams.set("run", section.dataset.run);
  target.searchParams.set("attempt", attempts[0]);
  const button = document.getElementById("mac-install-button");
  button.href = target.href;
  button.textContent = "Install on Mac";
  status.textContent = "Opening your Mentra installer. Allow your browser to open it if asked. If nothing opens, click Install on Mac or complete first-time setup below.";
  window.location.assign(target.href);
})();`
const macScriptPolicy = `; script-src 'sha256-${createHash("sha256").update(macInstallScript).digest("base64")}'`

// Called only after the publisher validates the handoff receipt and IPA bytes.
export function iosInstallationFiles(receipt, repository, release = undefined) {
  const {app} = receipt
  if (
    app?.bundleId !== "com.mentra.mentra" ||
    !/^\d+(\.\d+){0,2}$/.test(app.build ?? "") ||
    !/^\d+(\.\d+){0,2}$/.test(app.version ?? "")
  )
    throw new Error("Invalid iPhone installation app identity")

  const ipaName = receipt.artifacts.iphone.name
  const manifestName =
    release?.manifestName ?? ipaName.replace("mentra-ios-iphone-", "mentra-ios-manifest-").replace(/\.ipa$/, ".plist")
  const pageName =
    release?.pageName ?? ipaName.replace("mentra-ios-iphone-", "mentra-ios-install-").replace(/\.ipa$/, ".html")
  const ipaUrl = artifactUrl(repository, release?.tag ?? "pr-builds", ipaName)
  const manifestUrl = artifactUrl(repository, release?.tag ?? "pr-builds", manifestName)
  const installUrl = iosInstallUrl(manifestUrl)
  const prUrl = release?.url ?? `https://github.com/${repository}/pull/${receipt.pr}`
  const title = release?.identity ?? `PR #${receipt.pr}`
  const badge = release ? "MENTRA · TEST RELEASE" : "MENTRA · PR TEST BUILD"
  const backend = release?.backend ?? "dev"
  const retention = release ? "" : " PR downloads may be removed after 7 days."
  const macEnabled = !release && app.macPackageVersion === 2
  if (
    macEnabled &&
    (app.macInstaller !== "Install Mentra.app" ||
      !Number.isSafeInteger(receipt.pr) ||
      receipt.pr <= 0 ||
      !/^[a-f0-9]{40}$/.test(receipt.headSha) ||
      !Number.isSafeInteger(receipt.runId) ||
      receipt.runId <= 0)
  )
    throw new Error("Invalid Mac installation coordinates")
  const macUrl = macEnabled ? artifactUrl(repository, "pr-builds", receipt.artifacts.mac.name) : undefined
  return {
    manifest: {
      name: manifestName,
      content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict>
  <key>assets</key><array><dict>
    <key>kind</key><string>software-package</string>
    <key>url</key><string>${escape(ipaUrl)}</string>
  </dict></array>
  <key>metadata</key><dict>
    <key>bundle-identifier</key><string>${escape(app.bundleId)}</string>
    <key>bundle-version</key><string>${escape(app.build)}</string>
    <key>kind</key><string>software</string>
    <key>title</key><string>Mentra App</string>
  </dict>
</dict></array></dict></plist>
`,
    },
    install: {
      name: pageName,
      content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'${
    macEnabled ? macScriptPolicy : ""
  }">
  <title>Install Mentra App · ${escape(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: light-dark(#f4f7f5, #111a15); color: light-dark(#17251d, #e7f2eb); }
    main { max-width: 32rem; margin: 2rem auto; padding: 1rem 1.5rem; }
    h1 { font-size: 2.25rem; letter-spacing: -.04em; margin: .5rem 0 1rem; }
    p, li { line-height: 1.6; } ol { padding-left: 1.3rem; }
    a { color: light-dark(#087847, #69e5a5); text-underline-offset: .2em; }
    .badge { font-size: .8rem; letter-spacing: .08em; font-weight: 700; }
    .install { display: block; text-align: center; padding: 1rem; margin: 1.5rem 0; border-radius: .8rem; background: #087847; color: white; font-weight: 700; text-decoration: none; }
    .details { border-block: 1px solid light-dark(#cfddd3, #354b3d); padding: 1rem 0; }
    .secondary { font-size: .9rem; }
  </style>
</head>
<body><main>
  <p class="badge">${badge}</p>
  <h1${macEnabled ? ' id="install-heading"' : ""}>Install the Mentra App</h1>
  <p class="details">Version ${escape(app.version)} · Build ${escape(app.build)}<br>
    <a href="${escape(prUrl)}">${escape(title)}</a> · Commit ${escape(
      receipt.headSha.slice(0, 7),
    )} · ${escape(backend)} backend</p>
${macEnabled ? '  <section id="iphone-install">\n' : ""}  <a class="install" href="${escape(
        installUrl,
      )}">Install on iPhone</a>
  <ol>
    <li>Open this page in <strong>Safari on your iPhone</strong>. From Slack, use its menu to open the link in Safari.</li>
    <li>Tap <strong>Install on iPhone</strong>, then confirm <strong>Install</strong> in the iOS prompt.</li>
    <li>Return to your Home Screen. Wait for installation to finish, then open Mentra.</li>
  </ol>
  <p>Your iPhone must be registered with Mentra and included in this build’s provisioning profile. This build replaces the existing Mentra App; keep it installed to preserve its data.</p>
  <p class="secondary">No prompt? Open this page in Safari and tap Install again. If iOS cannot install it, check that your device is included and ask for a fresh build.${retention}</p>
  <p class="secondary"><a href="${escape(ipaUrl)}">Download IPA for installation with a Mac</a></p>
${
  macEnabled
    ? `  </section>
  <section id="mac-install" data-mentra-mac-install="1" data-number="${escape(receipt.pr)}" data-head="${escape(
    receipt.headSha,
  )}" data-run="${escape(receipt.runId)}" hidden>
    <a id="mac-install-button" class="install" href="${escape(macUrl)}">Download Mac installer</a>
    <p id="mac-status" role="status">Use Install on Mac in #pr-builds to open the installed Mentra installer.</p>
    <h2>First-time setup</h2>
    <ol>
      <li><a href="${escape(
        macUrl,
      )}">Download the Mac installer ZIP</a>, unzip it and open <strong>Install Mentra.app</strong>.</li>
      <li>Complete installation and any first-use macOS approvals. Your Mac must be registered for the build.</li>
      <li>Next time, use <strong>Install on Mac</strong> in #pr-builds. The installed helper downloads and opens the selected build without another ZIP in Downloads.</li>
    </ol>
    <p class="secondary">If your browser does not open the installer automatically, click Install on Mac above. Keep the helper installed for future builds. Downloads may be removed after 7 days.</p>
  </section>
`
    : ""
}</main>${macEnabled ? `<script>${macInstallScript}</script>` : ""}</body></html>
`,
    },
  }
}
