/** Existing AR99 vendor semantics, with host source/network policy injected at the device boundary. */
export interface Ar99SourceConfiguration {
  baseUrl: string
  developerId: string
  clientKey: string
}

export interface Ar99VersionInfo {
  changeLog: string
  currentVersion: string
  fileMd5: string
  firmwareUrl: string
  forceUpdate: boolean
  hasUpdate: boolean
}

export const AR99_OTA_HEADERS = {"Accept-Language": "en-US"}

export function parseAr99Source(value: unknown): Ar99SourceConfiguration | null {
  if (!value || typeof value !== "object") return null
  const config = value as Partial<Ar99SourceConfiguration>
  if (
    typeof config.baseUrl !== "string" ||
    typeof config.developerId !== "string" ||
    typeof config.clientKey !== "string"
  )
    throw new Error("Invalid AR99 firmware source configuration")
  const url = new URL(config.baseUrl)
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("AR99 vendor configuration requires HTTPS")
  return {baseUrl: url.toString(), developerId: config.developerId, clientKey: config.clientKey}
}

interface ApiResponse {
  code?: number
  msg?: string
  message?: string
  success?: boolean
  error?: {code?: number; detail?: string}
  data?: {change_log?: string; current_version?: string; force_update?: boolean; md5?: string; url?: string} | null
}

export async function checkAr99Release(
  source: Ar99SourceConfiguration,
  currentVersion: string,
  serialNumber: string,
  projectName: string,
  ports: {
    fetch: (input: string, init: RequestInit) => Promise<Response>
    sign: (key: string, appName: string, version: string, scope: string, nonce: string) => string
    nonce: () => string
  },
): Promise<Ar99VersionInfo> {
  const version = currentVersion.trim()
  const scope = serialNumber.trim()
  const appName = projectName.trim() || "AR99"
  const nonce = ports.nonce()
  const response = await ports.fetch(`${source.baseUrl}api/v2/applications/public/getVersionURL`, {
    method: "POST",
    headers: {...AR99_OTA_HEADERS, "Content-Type": "application/json"},
    body: JSON.stringify({
      app_name: appName,
      app_type: "juxinOTA",
      current_version: version,
      developerId: source.developerId,
      target_scope: scope,
      nonce,
      md5: ports.sign(source.clientKey, appName, version, scope, nonce),
    }),
  })
  const payload = (await response.json().catch(() => null)) as ApiResponse | null
  if (response.status === 553 || payload?.code === 553 || payload?.error?.code === 553)
    return {changeLog: "", currentVersion: version, fileMd5: "", firmwareUrl: "", forceUpdate: false, hasUpdate: false}
  const success = payload?.success === true || payload?.code === 0 || payload?.code === 200
  if (!response.ok || !payload || !success)
    throw new Error(
      payload?.error?.detail || payload?.msg || payload?.message || `Version check failed: ${response.status}`,
    )
  const data = payload.data ?? {}
  const latest = data.current_version?.trim() ?? ""
  const url = data.url?.trim() ?? ""
  return {
    changeLog: data.change_log ?? "",
    currentVersion: latest,
    fileMd5: data.md5?.trim().toLowerCase() ?? "",
    firmwareUrl: !url
      ? ""
      : /^https?:\/\//i.test(url)
      ? url
      : new URL(url.replace(/^\/+/, ""), source.baseUrl).toString(),
    forceUpdate: data.force_update === true,
    hasUpdate: url.length > 0 && latest.length > 0 && latest !== version,
  }
}
