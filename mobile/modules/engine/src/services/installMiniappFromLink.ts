/**
 * `installMiniappFromLink(link)`: install from whatever a person opened, scanned or pasted. A host app hands the
 * engine the link and supplies its own install sheet as `confirm`; the engine reads the link
 * ({@link parseMiniappLink}), asks the directory which URL serves a package link's package, and installs through
 * {@link installMiniapp}, like every other install.
 */
import {fetchListedMiniappUrl, parseMiniappLink, type MiniappLinkOptions} from "../miniapp-links"
import {installMiniapp, type InstallMiniappOptions, type InstallMiniappResult} from "./installMiniapp"

export interface InstallMiniappFromLinkOptions extends InstallMiniappOptions, MiniappLinkOptions {
  /**
   * The directory that says which URL serves a package link's package (Mentra's is `MINIAPP_DIRECTORY_URL`). Without
   * one, a package link is `no_directory`.
   */
  directoryUrl?: string
}

/**
 * Why a link named nothing to install. `not_a_link`: it isn't a miniapp link or a miniapp URL. `no_directory`: a
 * package link, and the host named no directory. `unlisted`: the directory lists no such package.
 * `directory_unreachable`: the directory couldn't answer.
 */
export type MiniappLinkErrorCode = "not_a_link" | "no_directory" | "unlisted" | "directory_unreachable"

export class MiniappLinkError extends Error {
  readonly code: MiniappLinkErrorCode

  constructor(code: MiniappLinkErrorCode, message: string, options: {cause?: unknown} = {}) {
    super(message)
    this.name = "MiniappLinkError"
    this.code = code
    if (options.cause !== undefined) (this as {cause?: unknown}).cause = options.cause
  }
}

/**
 * Install the miniapp a link names. Resolves as {@link installMiniapp} does; throws `MiniappLinkError` when the link
 * names nothing to install, and `InstallMiniappError` when the install stops.
 */
export async function installMiniappFromLink(
  link: string,
  options: InstallMiniappFromLinkOptions,
): Promise<InstallMiniappResult> {
  const {schemes, directoryUrl, ...install} = options
  const parsed = parseMiniappLink(link, {schemes})
  if (!parsed) throw new MiniappLinkError("not_a_link", "This isn't a link to a miniapp")
  if (parsed.kind === "url") return installMiniapp(parsed.url, install)
  if (!directoryUrl) {
    throw new MiniappLinkError("no_directory", `No directory to look up ${parsed.packageName} in`)
  }
  let url: string | null
  try {
    url = await fetchListedMiniappUrl(directoryUrl, parsed.packageName)
  } catch (cause) {
    throw new MiniappLinkError("directory_unreachable", `The directory couldn't look up ${parsed.packageName}`, {cause})
  }
  if (!url) throw new MiniappLinkError("unlisted", `The directory doesn't list ${parsed.packageName}`)
  // A URL that serves another package by now doesn't install.
  return installMiniapp(url, {...install, expectedPackageName: parsed.packageName})
}
