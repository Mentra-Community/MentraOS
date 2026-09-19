import {artifactUrl} from "./release-artifact-storage.mjs"

const escape = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

export const iosInstallUrl = (manifestUrl) =>
  `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`

// Called only after the publisher validates the handoff receipt and IPA bytes.
export function iosInstallationFiles(receipt, repository) {
  const {app} = receipt
  if (
    app?.bundleId !== "com.mentra.mentra" ||
    !/^\d+(\.\d+){0,2}$/.test(app.build ?? "") ||
    !/^\d+(\.\d+){0,2}$/.test(app.version ?? "")
  )
    throw new Error("Invalid iPhone installation app identity")

  const ipaName = receipt.artifacts.iphone.name
  const manifestName = ipaName.replace("mentra-ios-iphone-", "mentra-ios-manifest-").replace(/\.ipa$/, ".plist")
  const pageName = ipaName.replace("mentra-ios-iphone-", "mentra-ios-install-").replace(/\.ipa$/, ".html")
  const ipaUrl = artifactUrl(repository, "pr-builds", ipaName)
  const manifestUrl = artifactUrl(repository, "pr-builds", manifestName)
  const installUrl = iosInstallUrl(manifestUrl)
  const prUrl = `https://github.com/${repository}/pull/${receipt.pr}`
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>Install Mentra App · PR #${escape(receipt.pr)}</title>
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
  <p class="badge">MENTRA · PR TEST BUILD</p>
  <h1>Install the Mentra App</h1>
  <p class="details">Version ${escape(app.version)} · Build ${escape(app.build)}<br>
    <a href="${escape(prUrl)}">PR #${escape(receipt.pr)}</a> · Commit ${escape(
        receipt.headSha.slice(0, 7),
      )} · Dev backend</p>
  <a class="install" href="${escape(installUrl)}">Install on iPhone</a>
  <ol>
    <li>Open this page in <strong>Safari on your iPhone</strong>. From Slack, use its menu to open the link in Safari.</li>
    <li>Tap <strong>Install on iPhone</strong>, then confirm <strong>Install</strong> in the iOS prompt.</li>
    <li>Return to your Home Screen. Wait for installation to finish, then open Mentra.</li>
  </ol>
  <p>Your iPhone must be registered with Mentra and included in this build’s provisioning profile. This build replaces the existing Mentra App; keep it installed to preserve its data.</p>
  <p class="secondary">No prompt? Open this page in Safari and tap Install again. If iOS cannot install it, check that your device is included and ask for a fresh build. PR downloads may be removed after 7 days.</p>
  <p class="secondary"><a href="${escape(ipaUrl)}">Download IPA for installation with a Mac</a></p>
</main></body></html>
`,
    },
  }
}
