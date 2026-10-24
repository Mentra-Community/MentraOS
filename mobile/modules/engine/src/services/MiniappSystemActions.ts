/**
 * MiniappSystemActions
 *
 * Host side of `session.system.share`, `download` and `openUrl`: the OS share
 * sheet and the system browser. Extracted from LocalMiniappRuntime the same way
 * BlobStore is.
 *
 * Miniapp code is untrusted, so what it hands these is checked:
 *   - a share sends a web link, text, bytes the miniapp supplies, or a file
 *     from its own `session.blob` storage, never another path on the phone;
 *   - a download fetches only an http: or https: URL;
 *   - a file the host writes for either gets a safe name in a new directory of
 *     its own in the cache (miniappFiles.ts), so a name like `../x` cannot
 *     overwrite the Mentra App's files;
 *   - openUrl never opens a local file, content URI or script.
 */

import {Linking} from "react-native"
import Share from "react-native-share"
import {File, type Directory} from "expo-file-system"

import {MiniappErrorCode} from "@mentra/miniapp"
import {fileInside, writeHandoffFile, type Handoff} from "./miniappFiles"
import {isNetworkUrl, safeFileName, urlScheme} from "./miniappPaths"

const LOG_TAG = "LocalMiniappRuntime"
const OCTET = "application/octet-stream"
/** Schemes openUrl never opens: the phone's own files and content, and code. */
const UNOPENABLE_SCHEMES = new Set(["file", "content", "javascript", "data", "blob", "about"])

// Matches LocalMiniappRuntime.sendResult (see BlobStore).
type SendResult = (
  packageName: string,
  requestId: string | undefined,
  ok: boolean,
  result?: unknown,
  error?: {code: MiniappErrorCode; message: string},
) => void

export interface MiniappSystemActionsHooks {
  sendResult: SendResult
  /**
   * The directory holding this miniapp's own files (its `session.blob` store) in
   * the data partition it uses now. Throws while no account is known.
   */
  ownFilesDirectory: (packageName: string) => Directory
}

export class MiniappSystemActions {
  constructor(private readonly hooks: MiniappSystemActionsHooks) {}

  /**
   * The file `url` names when it is one of this miniapp's own files (inside its
   * blob storage, symlinks resolved); null for any other URL.
   */
  ownFile(packageName: string, url: unknown): File | null {
    let dir: Directory
    try {
      dir = this.hooks.ownFilesDirectory(packageName)
    } catch {
      return null
    }
    return fileInside(dir, url)
  }

  /**
   * Whether the host may play or show `url` for this miniapp: a network or
   * `data:` URL, or one of the miniapp's own files.
   */
  allowsMediaUrl(packageName: string, url: unknown): boolean {
    if (isNetworkUrl(url) || urlScheme(url) === "data") return true
    return urlScheme(url) === "file" && this.ownFile(packageName, url) !== null
  }

  async handleShare(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const {text, title, base64, mimeType, filename, url} = payload as {
      text?: string
      title?: string
      base64?: string
      mimeType?: string
      filename?: string
      url?: string
    }
    let handoff: Handoff | null = null
    try {
      if (base64) {
        const name = safeFileName(filename, "shared_file")
        handoff = await writeHandoffFile(name, "shared_file", (target) => target.write(base64, {encoding: "base64"}))
        await Share.open({url: handoff.file.uri, type: mimeType || OCTET, filename: name, title})
      } else if (url) {
        if (isNetworkUrl(url)) {
          await Share.open({url, title, message: text})
        } else {
          const own = this.ownFile(packageName, url)
          if (!own) {
            this.refuse(
              packageName,
              requestId,
              "share: url must be an http(s) link or a file from this miniapp's blob storage",
            )
            return
          }
          // A copy in the cache: Android's share provider serves only the cache,
          // and the sheet then gets a file the host placed, not a path it was given.
          handoff = await writeHandoffFile(own.name, "shared_file", (target) => own.copy(target))
          await Share.open({url: handoff.file.uri, title, message: text})
        }
      } else {
        await Share.open({message: text || "", title})
      }
      this.hooks.sendResult(packageName, requestId, true, {success: true})
    } catch (error: any) {
      // react-native-share throws when user dismisses the share sheet
      if (error?.message?.includes("User did not share")) {
        this.hooks.sendResult(packageName, requestId, true, {success: false, cancelled: true})
      } else {
        console.error(`${LOG_TAG}: share error:`, error)
        this.hooks.sendResult(packageName, requestId, true, {success: false})
      }
    } finally {
      handoff?.release()
    }
  }

  async handleOpenUrl(_packageName: string, payload: Record<string, unknown>): Promise<void> {
    const url = payload.url
    if (!url || typeof url !== "string") {
      console.warn(`${LOG_TAG}: open_url missing url`)
      return
    }
    const scheme = urlScheme(url)
    if (!scheme || UNOPENABLE_SCHEMES.has(scheme)) {
      console.warn(`${LOG_TAG}: open_url blocked ${scheme ? `${scheme}:` : "relative"} URL`)
      return
    }
    try {
      await Linking.openURL(url)
    } catch (error) {
      console.error(`${LOG_TAG}: open_url error:`, error)
    }
  }

  async handleDownload(packageName: string, payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const {base64, url, mimeType, filename} = payload as {
      base64?: string
      url?: string
      mimeType?: string
      filename?: string
    }
    if (!base64 && !url) {
      this.refuse(packageName, requestId, "download requires base64 or url")
      return
    }
    if (!base64 && !isNetworkUrl(url)) {
      this.refuse(packageName, requestId, "download: url must be an http: or https: URL")
      return
    }
    const name = safeFileName(filename, "download")
    let handoff: Handoff | null = null
    try {
      handoff = await writeHandoffFile(name, "download", (target) =>
        base64
          ? target.write(base64, {encoding: "base64"})
          : File.downloadFileAsync(url as string, target, {idempotent: true}),
      )
      // Open share sheet so user can choose where to save
      await Share.open({url: handoff.file.uri, type: mimeType || OCTET, filename: name})
      this.hooks.sendResult(packageName, requestId, true, {success: true})
    } catch (error: any) {
      if (error?.message?.includes("User did not share")) {
        this.hooks.sendResult(packageName, requestId, true, {success: true, cancelled: true})
      } else {
        console.error(`${LOG_TAG}: download error:`, error)
        this.hooks.sendResult(packageName, requestId, true, {success: false})
      }
    } finally {
      handoff?.release()
    }
  }

  private refuse(packageName: string, requestId: string | undefined, message: string): void {
    console.warn(`${LOG_TAG}: ${packageName}: ${message}`)
    this.hooks.sendResult(packageName, requestId, false, undefined, {code: MiniappErrorCode.INVALID_ARGUMENT, message})
  }
}
