/**
 * @fileoverview SystemModule — OS-level utilities (share, open URL, clipboard, download, QR scan).
 *
 * These bridge to native phone capabilities via LocalMiniappRuntime.
 */

import { MiniappRequestType } from "../protocol"
import { MiniappSession } from "../session"

export interface ShareOptions {
  text?: string
  url?: string
  title?: string
  /** Base64-encoded file data for file sharing. */
  base64?: string
  /** MIME type when sharing base64 data. */
  mimeType?: string
  /** Filename when sharing base64 data. */
  filename?: string
}

export interface ShareResult {
  success: boolean
  cancelled?: boolean
}

export interface DownloadOptions {
  /** URL to download from, OR base64 data. */
  url?: string
  base64?: string
  filename?: string
  mimeType?: string
}

export interface DownloadResult {
  success: boolean
  cancelled?: boolean
}

export interface ScanQrOptions {
  /** Header title on the phone scanner overlay. */
  title?: string
  /** Hint shown over the camera viewfinder. */
  hint?: string
}

export type ScanQrResult = {data: string; cancelled?: false} | {cancelled: true; data?: undefined}

export class SystemModule {
  constructor(private readonly session: MiniappSession) {}

  /** Open the OS share sheet with the given content. */
  async share(options: ShareOptions): Promise<ShareResult> {
    const result = await this.session.sendRequest<ShareResult>({
      type: MiniappRequestType.SHARE,
      ...options,
    })
    return result ?? { success: false }
  }

  /** Open a URL in the system browser. Blocks dangerous schemes (javascript:, file:). */
  openUrl(url: string): void {
    this.session.sendOneShot({
      type: MiniappRequestType.OPEN_URL,
      url,
    })
  }

  /** Copy text to the system clipboard. */
  async copyToClipboard(text: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.COPY_CLIPBOARD,
      text,
    })
  }

  /** Download a file. Opens the OS share sheet so user can choose save location. */
  async download(options: DownloadOptions): Promise<DownloadResult> {
    const result = await this.session.sendRequest<DownloadResult>({
      type: MiniappRequestType.DOWNLOAD,
      ...options,
    })
    return result ?? { success: false }
  }

  /**
   * Open the phone camera QR scanner as a host overlay. Does not unmount the
   * miniapp (so live sessions survive the scan). Resolves with the raw QR
   * payload, or `{cancelled: true}` if the user dismisses the scanner.
   */
  async scanQr(options: ScanQrOptions = {}): Promise<ScanQrResult> {
    const result = await this.session.sendRequest<ScanQrResult>(
      {
        type: MiniappRequestType.SCAN_QR,
        ...options,
      },
      {timeoutMs: 0},
    )
    return result ?? { cancelled: true }
  }
}
