/**
 * The `@mentra/engine` Expo config plugin: the host app claims Mentra's miniapp links, so a tap on an open link
 * (`https://apps.mentraglass.com/open?url=<miniapp URL>`) or a package link
 * (`https://apps.mentraglass.com/package/<packageName>`) opens the app, which hands the link to
 * `engine.miniapps.installFromLink`.
 *
 * - iOS: the link hosts join the app's Associated Domains (Universal Links). The directory website's
 *   apple-app-site-association file chooses the paths.
 * - Android: one verified intent filter (App Links) for the two paths on each host, so the rest of the directory
 *   website stays in the browser.
 *
 * The links open the app only once Mentra lists it on those hosts: see the engine docs, "Miniapp links".
 *
 * It only edits the Expo config, which Expo's own prebuild steps write into the entitlements and the manifest, so it
 * needs no build step and no `@expo/config-plugins`.
 *
 *   plugins: ["@mentra/engine"]                             // claim the links
 *   plugins: [["@mentra/engine", {miniappLinks: false}]]    // claim nothing
 */

/** The hosts miniapp links live on, as `src/miniapp-links` names them (scripts/app-plugin.test.mjs keeps them equal). */
const MINIAPP_LINK_HOSTS = ["apps.mentra.glass", "apps.mentraglass.com"]

/** The Android intent filter for the open link and the package link on each host. */
function miniappLinkIntentFilter() {
  return {
    action: "VIEW",
    autoVerify: true,
    data: MINIAPP_LINK_HOSTS.flatMap((host) => [
      {scheme: "https", host, path: "/open"},
      {scheme: "https", host, pathPrefix: "/package/"},
    ]),
    category: ["DEFAULT", "BROWSABLE"],
  }
}

/** The iOS Associated Domains entries for the link hosts. */
function miniappLinkAssociatedDomains() {
  return MINIAPP_LINK_HOSTS.map((host) => `applinks:${host}`)
}

/**
 * @param {import("expo/config").ExpoConfig} config
 * @param {{miniappLinks?: boolean} | void} props
 */
function withMentraEngine(config, props) {
  if (props && props.miniappLinks === false) return config

  const domains = [...(config.ios?.associatedDomains ?? [])]
  for (const domain of miniappLinkAssociatedDomains()) {
    if (!domains.includes(domain)) domains.push(domain)
  }

  const filter = miniappLinkIntentFilter()
  const filters = [...(config.android?.intentFilters ?? [])]
  // Applying the plugin twice claims the links once.
  if (!filters.some((existing) => JSON.stringify(existing) === JSON.stringify(filter))) filters.push(filter)

  return {
    ...config,
    ios: {...config.ios, associatedDomains: domains},
    android: {...config.android, intentFilters: filters},
  }
}

module.exports = withMentraEngine
module.exports.MINIAPP_LINK_HOSTS = MINIAPP_LINK_HOSTS
module.exports.miniappLinkIntentFilter = miniappLinkIntentFilter
module.exports.miniappLinkAssociatedDomains = miniappLinkAssociatedDomains
