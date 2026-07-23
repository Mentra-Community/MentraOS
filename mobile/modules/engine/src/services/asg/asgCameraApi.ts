/**
 * ASG Camera Server API Client
 * Provides methods to interact with the AsgCameraServer Java APIs
 */

import * as RNFS from "@dr.pogodin/react-native-fs"

import {PhotoInfo, CaptureGroup, GalleryResponse, ServerStatus, HealthResponse} from "../../types/asg"
import {BgTimer} from "../../utils/timers"

import {localStorageService} from "./localStorageService"
import {validateDownloadedMediaFile} from "./galleryMediaValidation"
import {reportInvalidGalleryMedia} from "./GalleryMediaIntegrityReportService"
import {galleryTransferLedger} from "./galleryTransferLedger"
import {localNetworkTransport} from "./localNetworkTransport"

export interface GalleryCapabilities {
  api_version: number
  range_downloads: boolean
  fixed_length_downloads: boolean
  etag: boolean
  sha256: boolean
  recoverable_trash: boolean
  idempotent_ack: boolean
  selected_capture?: boolean
  recommended_segment_bytes?: number
  max_manifest_page_size?: number
}

type V3ManifestResponse = {
  status: string
  data: {
    api_version: 3
    captures: CaptureGroup[]
    has_more: boolean
    next_cursor?: string | null
    total_count: number
    server_time: number
  }
}

export class AsgCameraApiClient {
  private baseUrl: string
  private port: number
  private lastRequestTime: number = 0
  private galleryCapabilities: GalleryCapabilities | null | undefined

  constructor(serverUrl?: string, port: number = 8089) {
    this.port = port
    this.baseUrl = serverUrl || `http://localhost:${port}`
    console.log(`[ASG Camera API] Client initialized with server: ${this.baseUrl}`)
  }

  private createTimeoutSignal(timeoutMs: number): AbortSignal {
    const controller = new AbortController()
    BgTimer.setTimeout(() => controller.abort(), timeoutMs)
    return controller.signal
  }

  /**
   * Set the server URL and port
   */
  setServer(serverUrl: string, port?: number) {
    console.log(`[ASG Camera API] setServer called with serverUrl: ${serverUrl}, port: ${port}`)
    const newPort = port || this.port
    const newUrl = `http://${serverUrl.replace(/^https?:\/\//, "")}:${newPort}`

    console.log(`[ASG Camera API] Constructed newUrl: ${newUrl}`)
    // console.log(`[ASG Camera API] Current baseUrl: ${this.baseUrl}`)

    // Only update if the URL actually changed
    if (this.baseUrl !== newUrl) {
      this.baseUrl = newUrl
      this.port = newPort
      this.galleryCapabilities = undefined
      // console.log(`[ASG Camera API] Server changed from ${oldUrl} to ${this.baseUrl}`)
    } else {
      // console.log(`[ASG Camera API] Server URL unchanged: ${this.baseUrl}`)
    }
  }

  /**
   * Get the current server URL
   */
  getServerUrl(): string {
    return this.baseUrl
  }

  /**
   * Rate limiting helper - ensures minimum delay between requests
   */
  private async rateLimit(minDelay: number = 500): Promise<void> {
    const now = Date.now()
    const timeSinceLastRequest = now - this.lastRequestTime

    if (timeSinceLastRequest < minDelay) {
      const delay = minDelay - timeSinceLastRequest
      console.log(`[ASG Camera API] Rate limiting: waiting ${delay}ms`)
      await new Promise<void>((resolve) => BgTimer.setTimeout(() => resolve(), delay))
    }

    this.lastRequestTime = Date.now()
  }

  /**
   * Make a request to the ASG Camera Server with rate limiting and retry logic
   */
  private async makeRequest<T>(
    endpoint: string,
    options?: RequestInit,
    retries: number = 5,
    writeIntervalMs: number = 500,
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`
    const method = options?.method || "GET"

    console.log(`[ASG Camera API] makeRequest called with endpoint: ${endpoint}`)
    console.log(`[ASG Camera API] Current baseUrl: ${this.baseUrl}`)
    console.log(`[ASG Camera API] Full URL: ${url}`)
    console.log(`[ASG Camera API] Method: ${method}`)
    console.log(`[ASG Camera API] Retries remaining: ${retries}`)
    console.log(`[ASG Camera API] Request options:`, {
      method,
      headers: options?.headers,
      body: options?.body ? "Present" : "None",
    })

    const startTime = Date.now()

    try {
      // Apply rate limiting only for non-GET requests
      if (method !== "GET" && writeIntervalMs > 0) {
        await this.rateLimit(writeIntervalMs)
      }

      // Prepare headers - don't set Content-Type for GET requests
      const headers: Record<string, string> = {
        "Accept": "application/json",
        "User-Agent": "MentraOS-Mobile/1.0",
      }
      if (method !== "GET") {
        headers["Content-Type"] = "application/json"
      }
      if (options?.headers) {
        Object.assign(headers, options.headers)
      }

      console.log(`[ASG Camera API] Making fetch request to: ${url}`)
      console.log(`[ASG Camera API] Headers being sent:`, headers)

      // N4: Add 30s timeout to all fetch calls in makeRequest
      const response = await localNetworkTransport.fetch(url, {
        headers,
        ...options,
        signal: options?.signal || this.createTimeoutSignal(30000),
      })

      const duration = Date.now() - startTime
      console.log(`[ASG Camera API] Response received in ${duration}ms:`, {
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get("content-type"),
        contentLength: response.headers.get("content-length"),
        url: response.url,
      })

      if (!response.ok) {
        console.error(`[ASG Camera API] HTTP Error ${response.status}: ${response.statusText}`)

        // Handle rate limiting with retry
        if (response.status === 429 && retries > 0) {
          // N3: Cap individual retry delay at 10s
          const retryDelay = Math.min(Math.pow(2, 6 - retries) * 1000, 10000)
          console.log(`[ASG Camera API] Rate limited, retrying in ${retryDelay}ms (${retries} retries left)`)
          await new Promise<void>((resolve) => BgTimer.setTimeout(() => resolve(), retryDelay))
          return this.makeRequest<T>(endpoint, options, retries - 1, writeIntervalMs)
        }

        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      // Handle different response types
      const contentType = response.headers.get("content-type")
      console.log(`[ASG Camera API] Response content-type: ${contentType}`)

      if (contentType?.includes("application/json")) {
        const data = await response.json()
        console.log(`[ASG Camera API] JSON response received`, {
          endpoint,
          status: data?.status,
          apiVersion: data?.data?.api_version,
          captureCount: data?.data?.captures?.length,
        })
        return data
      } else if (contentType?.includes("image/") || contentType?.includes("application/octet-stream")) {
        // For image responses and binary data (including AVIF), return the blob
        const blob = await response.blob()
        console.log(`[ASG Camera API] Binary/Image Response received:`, {
          size: blob.size,
          type: blob.type,
        })

        // Quick check if this might be an AVIF file
        if (contentType?.includes("application/octet-stream") && blob.size > 12) {
          const arrayBuffer = await blob.arrayBuffer()
          const bytes = new Uint8Array(arrayBuffer.slice(4, 12))
          const ftypSignature = String.fromCharCode(...bytes)
          if (ftypSignature === "ftypavif") {
            console.log(`[ASG Camera API] Detected AVIF file in response`)
          }
          // Return a new blob since we consumed the original
          return new Blob([arrayBuffer], {type: blob.type}) as T
        }

        return blob as T
      } else {
        // For text responses
        const text = await response.text()
        console.log(
          `[ASG Camera API] Text Response received:`,
          text.substring(0, 200) + (text.length > 200 ? "..." : ""),
        )
        return text as T
      }
    } catch (error) {
      const duration = Date.now() - startTime
      console.error(`[ASG Camera API] Error (${endpoint}) after ${duration}ms:`, error)
      console.error(`[ASG Camera API] Error details:`, {
        endpoint,
        url,
        method,
        duration,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      })
      throw error
    }
  }

  /**
   * Take a picture using the ASG camera
   */
  async takePicture(): Promise<{message: string}> {
    console.log(`[ASG Camera API] Taking picture...`)
    return this.makeRequest<{message: string}>("/api/take-picture", {
      method: "POST",
    })
  }

  /**
   * Get the latest photo as a blob
   */
  async getLatestPhoto(): Promise<Blob> {
    console.log(`[ASG Camera API] Getting latest photo...`)
    return this.makeRequest<Blob>("/api/latest-photo")
  }

  /**
   * Get the latest photo as a data URL
   */
  async getLatestPhotoAsDataUrl(): Promise<string> {
    console.log(`[ASG Camera API] Getting latest photo as data URL...`)
    const blob = await this.getLatestPhoto()
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  /**
   * Get gallery photos from the server with optional pagination
   */
  async getGallery(limit?: number, offset?: number): Promise<GalleryResponse> {
    console.log(`[ASG Camera API] getGallery called with limit=${limit}, offset=${offset}`)
    // console.log(`[ASG Camera API] Current baseUrl: ${this.baseUrl}`)

    // Build URL with optional query parameters
    let galleryUrl = `${this.baseUrl}/api/gallery`
    const params = new URLSearchParams()
    if (limit !== undefined) params.append("limit", limit.toString())
    if (offset !== undefined) params.append("offset", offset.toString())
    if (params.toString()) galleryUrl += `?${params.toString()}`

    console.log(`[ASG Camera API] Full gallery URL: ${galleryUrl}`)

    // Use browser-like headers since we know the browser works
    try {
      console.log(`[ASG Camera API] Making direct fetch to gallery endpoint`)
      const response = await localNetworkTransport.fetch(galleryUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json",
          "User-Agent": "MentraOS-Mobile/1.0",
        },
        signal: this.createTimeoutSignal(10000), // 10 second timeout
      })

      console.log(`[ASG Camera API] Response status: ${response.status}`)

      if (!response.ok) {
        throw new Error(`Gallery endpoint returned: ${response.status}`)
      }

      const responseText = await response.text()
      console.log(`[ASG Camera API] Raw response:`, responseText.substring(0, 1000))

      let data: any
      try {
        data = JSON.parse(responseText)
      } catch (parseError) {
        console.log(`[ASG Camera API] Failed to parse JSON:`, parseError)
        throw new Error("Invalid JSON response from gallery endpoint")
      }

      // Handle the exact response format we see from browser
      if (data && data.status === "success" && data.data?.photos) {
        console.log(`[ASG Camera API] Found ${data.data.photos.length} photos (total: ${data.data.total_count})`)

        // Map photos to ensure proper URL construction
        const photos = data.data.photos.map((photo: any) => ({
          ...photo,
          url: this.constructPhotoUrl(photo.url || photo.name),
          download: this.constructDownloadUrl(photo.download || photo.name),
        }))

        return {
          status: "success",
          data: {
            photos,
            total_count: data.data.total_count,
            returned_count: data.data.returned_count,
            has_more: data.data.has_more,
            offset: data.data.offset,
            limit: data.data.limit,
          },
        } as GalleryResponse
      } else {
        console.log(`[ASG Camera API] Invalid response structure:`, data)
        throw new Error("Invalid response structure from gallery endpoint")
      }
    } catch (error) {
      console.log(`[ASG Camera API] Gallery request failed:`, error)
      throw error
    }
  }

  async deleteGalleryPhoto(photoId: string): Promise<any> {
    const response = await this.makeRequest<any>(`/api/gallery/${photoId}`, {
      method: "DELETE",
    })
    console.log("Photo deleted successfully:", photoId)
    return response
  }

  /**
   * Get the gallery photos array with proper URL construction
   */
  async getGalleryPhotos(
    limit?: number,
    offset?: number,
  ): Promise<{
    photos: PhotoInfo[]
    hasMore: boolean
    totalCount: number
  }> {
    console.log(`[ASG Camera API] Getting gallery photos with limit=${limit}, offset=${offset}...`)
    try {
      const response = await this.getGallery(limit, offset)
      console.log(`[ASG Camera API] Gallery response:`, response)

      if (!response.data || !response.data.photos) {
        console.warn(`[ASG Camera API] Invalid gallery response structure:`, response)
        return {photos: [], hasMore: false, totalCount: 0}
      }

      const photos = response.data.photos
      console.log(`[ASG Camera API] Found ${photos.length} photos (total: ${(response.data as any).total_count})`)

      // Ensure each photo has proper URLs and detect AVIF files
      const processedPhotos = photos.map((photo) => {
        // Check if filename suggests AVIF (no extension or .avif)
        const mightBeAvif = !photo.name.includes(".") || photo.name.match(/\.(avif|avifs)$/i)

        return {
          ...photo,
          url: this.constructPhotoUrl(photo.name),
          download: this.constructDownloadUrl(photo.name),
          mime_type: photo.mime_type || (mightBeAvif ? "image/avif" : undefined),
        }
      })

      console.log(`[ASG Camera API] Processed photos:`, processedPhotos)
      return {
        photos: processedPhotos,
        hasMore: (response.data as any).has_more || false,
        totalCount: (response.data as any).total_count || photos.length,
      }
    } catch (error) {
      console.error(`[ASG Camera API] Error getting gallery photos:`, error)
      throw error
    }
  }

  /**
   * Discover available endpoints on the server
   */
  async discoverEndpoints(): Promise<string[]> {
    const availableEndpoints: string[] = []
    const testEndpoints = [
      "/",
      "/api",
      "/api/health",
      "/api/status",
      "/api/gallery",
      "/gallery",
      "/api/photos",
      "/photos",
      "/api/images",
      "/images",
      "/api/take-picture",
      "/api/latest-photo",
    ]

    console.log(`[ASG Camera API] Discovering available endpoints...`)

    for (const endpoint of testEndpoints) {
      try {
        console.log(`[ASG Camera API] Testing endpoint: ${endpoint}`)
        const response = await localNetworkTransport.fetch(`${this.baseUrl}${endpoint}`, {
          method: "HEAD",
          headers: {
            "Accept": "*/*",
            "User-Agent": "MentraOS-Mobile/1.0",
          },
          signal: this.createTimeoutSignal(5000),
        })

        if (response.ok) {
          availableEndpoints.push(endpoint)
          console.log(`[ASG Camera API] Found endpoint: ${endpoint} (${response.status})`)
        } else {
          console.log(`[ASG Camera API] Endpoint ${endpoint} returned: ${response.status}`)
        }
      } catch (error) {
        console.log(`[ASG Camera API] Endpoint ${endpoint} failed:`, error)
        // For /api/gallery specifically, let's try a GET request to see if it's a HEAD request issue
        if (endpoint === "/api/gallery") {
          try {
            console.log(`[ASG Camera API] Trying GET request for /api/gallery...`)
            const getResponse = await localNetworkTransport.fetch(`${this.baseUrl}${endpoint}`, {
              method: "GET",
              headers: {
                "Accept": "application/json",
                "User-Agent": "MentraOS-Mobile/1.0",
              },
              signal: this.createTimeoutSignal(5000),
            })
            console.log(`[ASG Camera API] GET /api/gallery status: ${getResponse.status}`)
            if (getResponse.ok) {
              console.log(`[ASG Camera API] GET /api/gallery works! Adding to available endpoints`)
              availableEndpoints.push(endpoint)
            }
          } catch (getError) {
            console.log(`[ASG Camera API] GET /api/gallery also failed:`, getError)
          }
        }
      }
    }

    console.log(`[ASG Camera API] Available endpoints:`, availableEndpoints)
    return availableEndpoints
  }

  /**
   * Construct a photo URL for a given filename
   */
  private constructPhotoUrl(filename: string): string {
    return `${this.baseUrl}/api/photo?file=${encodeURIComponent(filename)}`
  }

  /**
   * Construct a download URL for a given filename
   */
  private constructDownloadUrl(filename: string): string {
    return `${this.baseUrl}/api/download?file=${encodeURIComponent(filename)}`
  }

  /**
   * Get a specific photo by filename
   */
  async getPhoto(filename: string): Promise<Blob> {
    console.log(`[ASG Camera API] Getting photo: ${filename}`)
    return this.makeRequest<Blob>(`/api/photo?file=${encodeURIComponent(filename)}`)
  }

  /**
   * Get a specific photo as a data URL
   */
  async getPhotoAsDataUrl(filename: string): Promise<string> {
    console.log(`[ASG Camera API] Getting photo as data URL: ${filename}`)
    const blob = await this.getPhoto(filename)
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  }

  /**
   * Download a photo (returns download URL)
   */
  async downloadPhoto(filename: string): Promise<string> {
    console.log(`[ASG Camera API] Downloading photo: ${filename}`)
    const downloadUrl = `${this.baseUrl}/api/download?file=${encodeURIComponent(filename)}`
    console.log(`[ASG Camera API] Download URL: ${downloadUrl}`)
    return downloadUrl
  }

  /**
   * Get server status information
   */
  async getStatus(): Promise<ServerStatus> {
    console.log(`[ASG Camera API] Getting server status...`)
    return this.makeRequest<ServerStatus>("/api/status")
  }

  /**
   * Get server health check
   */
  async getHealth(): Promise<HealthResponse> {
    console.log(`[ASG Camera API] Getting server health...`)
    return this.makeRequest<HealthResponse>("/api/health")
  }

  /**
   * Get the index page (for testing)
   */
  async getIndexPage(): Promise<string> {
    console.log(`[ASG Camera API] Getting index page...`)
    return this.makeRequest<string>("/")
  }

  /**
   * Check if the server is reachable (simple ping)
   */
  async isServerReachable(): Promise<boolean> {
    try {
      console.log(`[ASG Camera API] Checking server reachability...`)
      // Use a simple HEAD request to check reachability
      const controller = new AbortController()
      const timeoutId = BgTimer.setTimeout(() => controller.abort(), 3000) // 3 second timeout

      const response = await localNetworkTransport.fetch(`${this.baseUrl}/api/health`, {
        method: "HEAD",
        signal: controller.signal,
      })

      BgTimer.clearTimeout(timeoutId)
      console.log(`[ASG Camera API] Server is reachable`)
      return response.ok
    } catch (error) {
      console.log(`[ASG Camera API] Server is not reachable:`, error)
      return false
    }
  }

  /**
   * Get comprehensive server information
   */
  async getServerInfo(): Promise<{
    reachable: boolean
    status?: ServerStatus
    health?: HealthResponse
    error?: string
  }> {
    try {
      const [status, health] = await Promise.all([this.getStatus(), this.getHealth()])

      return {
        reachable: true,
        status,
        health,
      }
    } catch (error) {
      return {
        reachable: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }
    }
  }

  /**
   * Sync with server to get changed files since last sync
   */
  async syncWithServer(
    clientId: string,
    lastSyncTime?: number,
    includeThumbnails: boolean = false,
  ): Promise<{
    status: string
    data: {
      api_version?: number
      client_id: string
      captures?: CaptureGroup[]
      changed_files: PhotoInfo[]
      deleted_files: string[]
      server_time: number
      total_changed: number
      total_size: number
    }
  }> {
    const params = new URLSearchParams({
      client_id: clientId,
      include_thumbnails: includeThumbnails.toString(),
    })

    if (lastSyncTime) {
      params.append("last_sync_time", lastSyncTime.toString())
    }

    const response = await this.makeRequest(`/api/sync?${params.toString()}`, {
      method: "GET",
    })

    return response as {
      status: string
      data: {
        api_version?: number
        client_id: string
        captures?: CaptureGroup[]
        changed_files: PhotoInfo[]
        deleted_files: string[]
        server_time: number
        total_changed: number
        total_size: number
      }
    }
  }

  /** Probe the additive gallery protocol. A 404 cleanly falls back to legacy v2. */
  async getGalleryCapabilities(): Promise<GalleryCapabilities | null> {
    if (this.galleryCapabilities !== undefined) return this.galleryCapabilities
    try {
      const response = await localNetworkTransport.fetch(`${this.baseUrl}/api/v3/capabilities`, {
        headers: {"Accept": "application/json", "User-Agent": "MentraOS-Mobile/1.0"},
        signal: this.createTimeoutSignal(5000),
      })
      if (response.status === 404) {
        this.galleryCapabilities = null
        return null
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      const capabilities = (payload.data || payload) as GalleryCapabilities
      this.galleryCapabilities = capabilities.api_version >= 3 ? capabilities : null
      return this.galleryCapabilities
    } catch (error) {
      // A failed probe must not break old firmware. Do not permanently cache transient failures.
      console.warn("[ASG Camera API] v3 capability probe failed; using legacy sync for this attempt", error)
      return null
    }
  }

  /** Fetch all lightweight v3 manifest pages, newest first. */
  async getV3Manifest(): Promise<V3ManifestResponse["data"] | null> {
    const capabilities = await this.getGalleryCapabilities()
    if (!capabilities) return null

    const captures: CaptureGroup[] = []
    let cursor: string | undefined
    let serverTime = Date.now()
    let totalCount = 0
    do {
      const params = new URLSearchParams({limit: String(capabilities.max_manifest_page_size || 100)})
      if (cursor) params.set("cursor", cursor)
      const response = await this.makeRequest<V3ManifestResponse>(`/api/v3/manifest?${params.toString()}`)
      const data = response.data || (response as unknown as V3ManifestResponse["data"])
      captures.push(...(data.captures || []))
      serverTime = data.server_time || serverTime
      totalCount = data.total_count || captures.length
      cursor = data.has_more && data.next_cursor ? data.next_cursor : undefined
    } while (cursor)

    return {
      api_version: 3,
      captures,
      has_more: false,
      next_cursor: null,
      total_count: totalCount,
      server_time: serverTime,
    }
  }

  async getV3FileHash(fileName: string): Promise<{sha256: string; etag: string; size: number}> {
    const response = await localNetworkTransport.fetch(
      `${this.baseUrl}/api/v3/hash?file=${encodeURIComponent(fileName)}`,
      {
        headers: {"Accept": "application/json", "User-Agent": "MentraOS-Mobile/1.0"},
        signal: this.createTimeoutSignal(10 * 60 * 1000),
      },
      10 * 60 * 1000,
    )
    if (!response.ok) throw new Error(`Hash request failed: HTTP ${response.status}`)
    const payload = await response.json()
    return (payload.data || payload) as {sha256: string; etag: string; size: number}
  }

  async acknowledgeCapture(captureId: string, ackId: string): Promise<void> {
    const response = await this.makeRequest<any>(
      "/api/v3/ack",
      {
        method: "POST",
        body: JSON.stringify({capture_id: captureId, ack_id: ackId}),
      },
      5,
      0,
    )
    const data = response.data || response
    if (!data.success && !data.already_trashed) {
      throw new Error(data.message || `Glasses did not acknowledge ${captureId}`)
    }
  }

  async restoreCapture(captureId: string): Promise<void> {
    const response = await this.makeRequest<any>(
      "/api/v3/restore",
      {
        method: "POST",
        body: JSON.stringify({capture_id: captureId}),
      },
      5,
      0,
    )
    const data = response.data || response
    if (!data.success) throw new Error(data.message || `Glasses did not restore ${captureId}`)
  }

  /**
   * Batch sync files from server with controlled concurrency.
   * Used by the legacy executeDownload path for old asg_client firmware
   * that doesn't send api_version=2.
   */
  async batchSyncFiles(
    files: PhotoInfo[],
    includeThumbnails: boolean = false,
    onProgress?: (
      current: number,
      total: number,
      fileName: string,
      fileProgress?: number,
      downloadedFile?: PhotoInfo,
    ) => void,
    abortSignal?: AbortSignal,
  ): Promise<{
    downloaded: PhotoInfo[]
    failed: string[]
    total_size: number
  }> {
    const results = {
      downloaded: [] as PhotoInfo[],
      failed: [] as string[],
      total_size: 0,
    }

    // Process files in parallel batches for better performance
    // Use controlled concurrency to avoid overwhelming the network
    const CONCURRENCY_LIMIT = 1

    // Process files in batches
    for (let i = 0; i < files.length; i += CONCURRENCY_LIMIT) {
      const batch = files.slice(i, i + CONCURRENCY_LIMIT)
      console.log(
        `[ASG Camera API] Processing batch ${Math.floor(i / CONCURRENCY_LIMIT) + 1}/${Math.ceil(
          files.length / CONCURRENCY_LIMIT,
        )}: ${batch.length} files`,
      )

      // Process batch in parallel
      const batchPromises = batch.map(async (file, batchIndex) => {
        const globalIndex = i + batchIndex

        // Report progress if callback provided - start of this file (0%)
        if (onProgress) {
          onProgress(globalIndex + 1, files.length, file.name, 0)
        }

        try {
          console.log(`[ASG Camera API] Downloading file ${globalIndex + 1}/${files.length}: ${file.name}`)

          // Download file with progress tracking
          const fileData = await this.downloadFile(
            file.name,
            includeThumbnails,
            (fileProgress) => {
              if (onProgress) {
                onProgress(globalIndex + 1, files.length, file.name, fileProgress)
              }
            },
            abortSignal,
            file.size, // Pass expected size for validation when Content-Length is missing
          )

          // Combine file info with downloaded file paths
          const downloadedFile = {
            ...file,
            filePath: fileData.filePath,
            thumbnailPath: fileData.thumbnailPath,
            mime_type: fileData.mime_type || file.mime_type,
          }

          console.log(`[ASG Camera API] Successfully downloaded: ${file.name}`)

          // Notify progress callback that this file is complete with file info
          if (onProgress) {
            onProgress(globalIndex + 1, files.length, file.name, 100, downloadedFile)
          }

          // Don't delete from glasses here — deletion is deferred until after
          // processing completes (in mediaProcessingQueue) to avoid data loss on crash.

          return {downloadedFile, fileSize: file.size}
        } catch (error: any) {
          // Re-throw cancellation so it terminates the entire batch
          if (error?.message === "Sync cancelled") {
            throw error
          }
          console.error(`[ASG Camera API] Failed to download ${file.name}:`, error)
          return {error: file.name}
        }
      })

      // Wait for batch to complete
      const batchResults = await Promise.all(batchPromises)

      // Process batch results
      for (const result of batchResults) {
        if ("downloadedFile" in result && result.downloadedFile) {
          results.downloaded.push(result.downloadedFile)
          results.total_size += result.fileSize || 0
        } else if ("error" in result) {
          results.failed.push(result.error)
        }
      }
    }

    console.log(
      `[ASG Camera API] Batch sync completed: ${results.downloaded.length} downloaded, ${results.failed.length} failed`,
    )
    return results
  }

  /**
   * Download all files in a capture group sequentially.
   * Reports aggregate byte progress across all files in the group.
   */
  private async downloadResumableCaptureFile(
    captureId: string,
    file: CaptureGroup["files"][number],
    localFilePath: string,
    onProgress?: (bytesDownloaded: number) => void,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const segmentBytes = 16 * 1024 * 1024
    const segmentCount = Math.max(1, Math.ceil(file.size / segmentBytes))
    const generation = (file.etag || `${file.size}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || "legacy"
    const partPath = (index: number) => `${localFilePath}.partial.${generation}.${index}`
    const assemblingPath = `${localFilePath}.assembling.${generation}`
    const transferStartedAt = Date.now()
    let networkDurationMs = 0
    let networkBytes = 0

    if (await RNFS.exists(localFilePath)) {
      const existing = await RNFS.stat(localFilePath)
      if (existing.size === file.size) {
        if (file.etag) {
          const remoteHash = file.sha256 ? {sha256: file.sha256, etag: file.etag} : await this.getV3FileHash(file.name)
          if (remoteHash.etag && remoteHash.etag !== file.etag) {
            throw new Error("Source generation changed before existing-file verification")
          }
          const localHash = await RNFS.hash(localFilePath, "sha256")
          if (localHash.toLowerCase() === remoteHash.sha256.toLowerCase()) {
            galleryTransferLedger.markFileHash(captureId, file.name, localHash.toLowerCase())
            onProgress?.(file.size)
            return
          }
          console.warn(`[ASG Camera API] Existing file failed SHA-256 verification; replacing ${file.name}`)
        } else {
          // Legacy servers have no generation/hash endpoint. Preserve old-client
          // compatibility and let the media validator below reject corrupt data.
          onProgress?.(file.size)
          return
        }
      }
      await RNFS.moveFile(localFilePath, `${localFilePath}.recovery.${Date.now()}`).catch(() => {})
    }

    let completedBytes = 0
    let resumedSegmentCount = 0
    for (let index = 0; index < segmentCount; index++) {
      const start = index * segmentBytes
      const expectedLength = Math.min(segmentBytes, file.size - start)
      if (await RNFS.exists(partPath(index))) {
        const stat = await RNFS.stat(partPath(index))
        if (stat.size === expectedLength) {
          completedBytes += expectedLength
          resumedSegmentCount++
          galleryTransferLedger.markSegmentComplete(captureId, file.name, index)
          continue
        }
        await RNFS.unlink(partPath(index)).catch(() => {})
      }

      let completed = false
      let lastError: unknown
      for (let attempt = 0; attempt < 5 && !completed; attempt++) {
        if (abortSignal?.aborted) throw new Error("Sync cancelled")
        await RNFS.unlink(partPath(index)).catch(() => {})
        const end = start + expectedLength - 1
        let responseHeaders: Record<string, string> = {}
        const {jobId, promise} = localNetworkTransport.downloadFile({
          fromUrl: `${this.baseUrl}/api/download?file=${encodeURIComponent(file.name)}`,
          toFile: partPath(index),
          headers: {
            "Accept": "*/*",
            "User-Agent": "MentraOS-Mobile/1.0",
            "Range": `bytes=${start}-${end}`,
            ...(file.etag ? {"If-Range": file.etag} : {}),
          },
          connectionTimeout: 300000,
          readTimeout: 300000,
          backgroundTimeout: 24 * 60 * 60 * 1000,
          progressDivider: 2,
          progressInterval: 250,
          begin: (response) => {
            responseHeaders = response.headers || {}
          },
          progress: (progress) => onProgress?.(completedBytes + (progress.bytesWritten || 0)),
        })

        let abortPollTimer: number | undefined
        if (abortSignal) {
          abortPollTimer = BgTimer.setInterval(() => {
            if (abortSignal.aborted) localNetworkTransport.stopDownload(jobId)
          }, 500)
        }

        const attemptStartedAt = Date.now()
        try {
          const result = await promise
          const attemptDurationMs = Math.max(1, Date.now() - attemptStartedAt)
          networkDurationMs += attemptDurationMs
          networkBytes += result.bytesWritten || 0
          if (abortSignal?.aborted) throw new Error("Sync cancelled")
          const header = (name: string): string | undefined => {
            const key = Object.keys(responseHeaders).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
            return key ? responseHeaders[key] : undefined
          }

          if (result.statusCode === 200 && index === 0 && result.bytesWritten === file.size) {
            // Older servers ignore Range. A full fixed/chunked response is still compatible;
            // commit it through the same staging path and skip the remaining segments.
            await RNFS.unlink(assemblingPath).catch(() => {})
            await RNFS.moveFile(partPath(index), assemblingPath)
            completedBytes = file.size
            completed = true
            break
          }
          if (result.statusCode !== 206) throw new Error(`HTTP ${result.statusCode}; expected 206`)
          if (result.bytesWritten !== expectedLength) {
            throw new Error(`Segment ${index} truncated: ${result.bytesWritten}/${expectedLength} bytes`)
          }
          const contentRange = header("content-range")
          if (contentRange !== `bytes ${start}-${end}/${file.size}`) {
            throw new Error(`Invalid Content-Range: ${contentRange || "missing"}`)
          }
          const responseEtag = header("etag")
          if (file.etag && responseEtag && responseEtag !== file.etag) {
            throw new Error("Source generation changed during transfer")
          }
          galleryTransferLedger.markSegmentComplete(captureId, file.name, index)
          completedBytes += expectedLength
          completed = true
          console.log("[ASG Camera API] Gallery segment complete", {
            captureId,
            file: file.name,
            segment: index,
            segmentCount,
            attempt: attempt + 1,
            status: result.statusCode,
            bytes: result.bytesWritten,
            durationMs: attemptDurationMs,
            throughputMbps: (((result.bytesWritten || 0) * 8) / attemptDurationMs / 1000).toFixed(2),
            etag: file.etag,
          })
        } catch (error) {
          lastError = error
          if (error instanceof Error && error.message === "Sync cancelled") throw error
          console.warn("[ASG Camera API] Gallery segment attempt failed", {
            captureId,
            file: file.name,
            segment: index,
            segmentCount,
            attempt: attempt + 1,
            rangeStart: start,
            rangeEnd: end,
            message: error instanceof Error ? error.message : String(error),
          })
          await RNFS.unlink(partPath(index)).catch(() => {})
          if (attempt < 4) {
            const delay = Math.min(1000 * 2 ** attempt, 10000) + Math.floor(Math.random() * 500)
            await new Promise<void>((resolve) => BgTimer.setTimeout(resolve, delay))
          }
        } finally {
          if (abortPollTimer !== undefined) BgTimer.clearInterval(abortPollTimer)
        }
      }
      if (!completed) throw lastError || new Error(`Segment ${index} failed`)
      if (completedBytes === file.size && (await RNFS.exists(assemblingPath))) break
    }

    if (!(await RNFS.exists(assemblingPath))) {
      await RNFS.unlink(assemblingPath).catch(() => {})
      await RNFS.writeFile(assemblingPath, "", "utf8")
      for (let index = 0; index < segmentCount; index++) {
        const data = await RNFS.readFile(partPath(index), "base64")
        await RNFS.appendFile(assemblingPath, data, "base64")
      }
    }

    const assembledStat = await RNFS.stat(assemblingPath)
    if (assembledStat.size !== file.size) {
      await RNFS.moveFile(assemblingPath, `${assemblingPath}.invalid.${Date.now()}`).catch(() => {})
      throw new Error(`Assembled file has ${assembledStat.size}/${file.size} bytes`)
    }

    const verificationStartedAt = Date.now()
    const capabilities = await this.getGalleryCapabilities()
    if (capabilities?.sha256) {
      const remoteHash = file.sha256 ? {sha256: file.sha256, etag: file.etag} : await this.getV3FileHash(file.name)
      if (file.etag && remoteHash.etag && file.etag !== remoteHash.etag) {
        throw new Error("Source generation changed before integrity verification")
      }
      const localHash = await RNFS.hash(assemblingPath, "sha256")
      if (localHash.toLowerCase() !== remoteHash.sha256.toLowerCase()) {
        await RNFS.moveFile(assemblingPath, `${assemblingPath}.invalid.${Date.now()}`).catch(() => {})
        throw new Error(`SHA-256 mismatch for ${file.name}`)
      }
      galleryTransferLedger.markFileHash(captureId, file.name, localHash.toLowerCase())
    }

    await RNFS.moveFile(assemblingPath, localFilePath)
    for (let index = 0; index < segmentCount; index++) await RNFS.unlink(partPath(index)).catch(() => {})
    console.log("[ASG Camera API] Gallery file committed", {
      captureId,
      file: file.name,
      bytes: file.size,
      segments: segmentCount,
      networkDurationMs,
      networkMbps: networkDurationMs > 0 ? ((networkBytes * 8) / networkDurationMs / 1000).toFixed(2) : "0.00",
      verificationDurationMs: Date.now() - verificationStartedAt,
      totalDurationMs: Date.now() - transferStartedAt,
      resumedSegments: resumedSegmentCount,
    })
    onProgress?.(file.size)
  }

  async downloadCapture(
    capture: CaptureGroup,
    onProgress?: (bytesDownloaded: number, totalBytes: number) => void,
    abortSignal?: AbortSignal,
  ): Promise<{
    captureDir: string
    primaryPath: string
    bracketPaths: string[]
    sidecarPath?: string
    thumbnailPath?: string
  }> {
    if (capture.files.some((file) => !file.size || file.size <= 0)) {
      // Preserve support for malformed manifests from pre-v2 development firmware.
      return this.downloadCaptureLegacyUnsafe(capture, onProgress, abortSignal)
    }
    const captureDir = localStorageService.getPhotoFilePath(capture.capture_id)
    if (!(await RNFS.exists(captureDir))) await RNFS.mkdir(captureDir)
    const capabilities = await this.getGalleryCapabilities()
    galleryTransferLedger.ensureCapture(capture, capabilities?.api_version || 2)
    galleryTransferLedger.transition(capture.capture_id, "TRANSFERRING")

    const sortedFiles = [...capture.files].sort((a, b) => {
      const order = {bracket: 0, primary: 1, sidecar: 2}
      return (order[a.role] ?? 1) - (order[b.role] ?? 1)
    })
    let completedCaptureBytes = 0
    let primaryPath = ""
    const bracketPaths: string[] = []
    let sidecarPath: string | undefined

    try {
      for (const file of sortedFiles) {
        const leafName = file.name.includes("/") ? file.name.split("/").pop()! : file.name
        const localFilePath = `${captureDir}/${leafName}`
        await this.downloadResumableCaptureFile(
          capture.capture_id,
          file,
          localFilePath,
          (fileBytes) => onProgress?.(completedCaptureBytes + fileBytes, capture.total_size),
          abortSignal,
        )

        const isVideo = !!file.name.match(/\.(mp4|mov|avi|webm|mkv)$/i)
        const mediaKind = file.role === "sidecar" ? "unknown" : isVideo ? "video" : "photo"
        try {
          await validateDownloadedMediaFile({
            path: localFilePath,
            name: file.name,
            expectedSize: file.size,
            mediaKind,
          })
        } catch (validationError: any) {
          reportInvalidGalleryMedia({
            name: file.name,
            path: localFilePath,
            mediaKind,
            stage: "download_capture_validation",
            reason: validationError?.message || String(validationError),
            expectedSize: file.size,
            captureId: capture.capture_id,
            duration: capture.duration,
          })
          await RNFS.moveFile(localFilePath, `${localFilePath}.invalid.${Date.now()}`).catch(() => {})
          throw validationError
        }

        completedCaptureBytes += file.size
        if (file.role === "primary") primaryPath = localFilePath
        else if (file.role === "bracket") bracketPaths.push(localFilePath)
        else if (file.role === "sidecar") sidecarPath = localFilePath
      }
      if (!primaryPath && sortedFiles.length > 0) {
        const leafName = sortedFiles[0].name.includes("/") ? sortedFiles[0].name.split("/").pop()! : sortedFiles[0].name
        primaryPath = `${captureDir}/${leafName}`
      }
      const primaryFile = sortedFiles.find((file) => file.role === "primary") || sortedFiles[0]
      const thumbnailPath =
        capture.type === "video" && primaryFile
          ? await this.downloadVideoThumbnail(primaryFile.name, `${captureDir}/.thumb.jpg`, abortSignal)
          : undefined
      galleryTransferLedger.transition(capture.capture_id, "VERIFIED")
      onProgress?.(capture.total_size, capture.total_size)
      return {captureDir, primaryPath, bracketPaths, sidecarPath, thumbnailPath}
    } catch (error) {
      galleryTransferLedger.recordFailure(capture.capture_id, error)
      throw error
    }
  }

  /** Previous direct-to-final implementation kept for binary-source compatibility only. */
  private async downloadCaptureLegacyUnsafe(
    capture: CaptureGroup,
    onProgress?: (bytesDownloaded: number, totalBytes: number) => void,
    abortSignal?: AbortSignal,
  ): Promise<{
    captureDir: string
    primaryPath: string
    bracketPaths: string[]
    sidecarPath?: string
    thumbnailPath?: string
  }> {
    const captureDir = localStorageService.getPhotoFilePath(capture.capture_id)
    console.log(
      `[ASG Camera API] downloadCapture: ${capture.capture_id} (${capture.files.length} files) -> ${captureDir}`,
    )

    // Ensure capture directory exists
    const dirExists = await RNFS.exists(captureDir)
    if (!dirExists) {
      await RNFS.mkdir(captureDir)
      console.log(`[ASG Camera API] downloadCapture: created dir ${captureDir}`)
    }

    let primaryPath = ""
    const bracketPaths: string[] = []
    let sidecarPath: string | undefined

    let totalBytesDownloaded = 0
    const totalBytes = capture.total_size

    // Sort files: brackets first, then primary, then sidecar
    // This ensures brackets are available before merge runs on the primary
    const sortedFiles = [...capture.files].sort((a, b) => {
      const order = {bracket: 0, primary: 1, sidecar: 2}
      return (order[a.role] ?? 1) - (order[b.role] ?? 1)
    })

    for (const file of sortedFiles) {
      // Derive local filename: use leaf of path if folder-based, otherwise full name
      const leafName = file.name.includes("/") ? file.name.split("/").pop()! : file.name
      const localFilePath = `${captureDir}/${leafName}`

      const isVideo = file.name.match(/\.(mp4|mov|avi|webm|mkv)$/i)
      const downloadEndpoint = isVideo ? "download" : "photo"
      const downloadUrl = `${this.baseUrl}/api/${downloadEndpoint}?file=${encodeURIComponent(file.name)}`

      console.log(`[ASG Camera API] downloadCapture: downloading ${file.name} (${file.role}) -> ${localFilePath}`)

      try {
        // Throttle progress: only fire when bytesWritten changes meaningfully
        let lastReportedBytes = -1
        const {jobId, promise: dlPromise} = localNetworkTransport.downloadFile({
          fromUrl: downloadUrl,
          toFile: localFilePath,
          headers: {
            "Accept": "*/*",
            "User-Agent": "MentraOS-Mobile/1.0",
          },
          connectionTimeout: 300000,
          readTimeout: 300000,
          backgroundTimeout: 600000,
          progressDivider: 5,
          progressInterval: 250,
          progress: (res: {bytesWritten: number}) => {
            const currentBytes = totalBytesDownloaded + (res.bytesWritten || 0)
            if (onProgress && currentBytes !== lastReportedBytes) {
              lastReportedBytes = currentBytes
              onProgress(currentBytes, totalBytes)
            }
          },
        })

        // Wire up abort signal via polling (safe for all Hermes versions)
        let abortPollTimer: number | undefined
        if (abortSignal) {
          if (abortSignal.aborted) {
            localNetworkTransport.stopDownload(jobId)
            throw new Error("Sync cancelled")
          }
          abortPollTimer = BgTimer.setInterval(() => {
            if (abortSignal.aborted) {
              localNetworkTransport.stopDownload(jobId)
            }
          }, 500)
        }

        let downloadResult
        try {
          downloadResult = await dlPromise
        } finally {
          if (abortPollTimer !== undefined) BgTimer.clearInterval(abortPollTimer)
        }

        if (downloadResult.statusCode !== 200) {
          await RNFS.unlink(localFilePath).catch(() => {})
          throw new Error(`HTTP ${downloadResult.statusCode}`)
        }

        // Check if aborted after completion
        if (abortSignal?.aborted) {
          await RNFS.unlink(localFilePath).catch(() => {})
          throw new Error("Sync cancelled")
        }

        const mediaKind = file.role === "sidecar" ? "unknown" : isVideo ? "video" : "photo"
        try {
          await validateDownloadedMediaFile({
            path: localFilePath,
            name: file.name,
            expectedSize: file.size,
            mediaKind,
          })
        } catch (validationErr: any) {
          const reason = validationErr?.message || validationErr?.toString?.() || JSON.stringify(validationErr)
          reportInvalidGalleryMedia({
            name: file.name,
            path: localFilePath,
            mediaKind,
            stage: "download_capture_validation",
            reason,
            expectedSize: file.size,
            captureId: capture.capture_id,
            duration: capture.duration,
          })
          await RNFS.unlink(localFilePath).catch(() => {})
          throw validationErr
        }

        console.log(`[ASG Camera API] downloadCapture: completed ${file.name} (${file.size} bytes)`)
      } catch (dlErr: any) {
        // S2: Clean up partial file on failure
        await RNFS.unlink(localFilePath).catch(() => {})
        const errMsg = dlErr?.message || dlErr?.toString?.() || JSON.stringify(dlErr)
        console.error(`[ASG Camera API] downloadCapture: FAILED ${file.name}: ${errMsg}`)
        throw new Error(`Failed to download ${file.name}: ${errMsg}`)
      }

      totalBytesDownloaded += file.size

      if (file.role === "primary") {
        primaryPath = localFilePath
      } else if (file.role === "bracket") {
        bracketPaths.push(localFilePath)
      } else if (file.role === "sidecar") {
        sidecarPath = localFilePath
      }
    }

    // C3: If no file was marked as primary, fall back to first downloaded file
    if (primaryPath === "" && sortedFiles.length > 0) {
      const leafName = sortedFiles[0].name.includes("/") ? sortedFiles[0].name.split("/").pop()! : sortedFiles[0].name
      primaryPath = `${captureDir}/${leafName}`
      console.warn(`[ASG Camera API] downloadCapture: No primary file found, falling back to ${primaryPath}`)
    }

    // Report final progress
    if (onProgress) {
      onProgress(totalBytes, totalBytes)
    }

    const primaryFile = sortedFiles.find((file) => file.role === "primary") || sortedFiles[0]
    const thumbnailPath =
      capture.type === "video" && primaryFile
        ? await this.downloadVideoThumbnail(primaryFile.name, `${captureDir}/.thumb.jpg`, abortSignal)
        : undefined

    return {captureDir, primaryPath, bracketPaths, sidecarPath, thumbnailPath}
  }

  /** Download an on-demand video thumbnail while the source capture is still on the glasses. */
  private async downloadVideoThumbnail(
    sourceFileName: string,
    thumbnailPath: string,
    abortSignal?: AbortSignal,
  ): Promise<string | undefined> {
    const partialPath = `${thumbnailPath}.partial`
    const parentDir = thumbnailPath.substring(0, thumbnailPath.lastIndexOf("/"))

    try {
      if (parentDir && !(await RNFS.exists(parentDir))) {
        await RNFS.mkdir(parentDir)
      }
      await RNFS.unlink(partialPath).catch(() => {})
      const {jobId, promise} = localNetworkTransport.downloadFile({
        fromUrl: `${this.baseUrl}/api/photo?file=${encodeURIComponent(sourceFileName)}`,
        toFile: partialPath,
        headers: {
          "Accept": "image/jpeg",
          "User-Agent": "MentraOS-Mobile/1.0",
        },
        connectionTimeout: 60000,
        readTimeout: 60000,
        progressDivider: 10,
      })

      let abortPollTimer: number | undefined
      if (abortSignal) {
        if (abortSignal.aborted) {
          localNetworkTransport.stopDownload(jobId)
          throw new Error("Sync cancelled")
        }
        abortPollTimer = BgTimer.setInterval(() => {
          if (abortSignal.aborted) localNetworkTransport.stopDownload(jobId)
        }, 500)
      }

      let result
      try {
        result = await promise
      } finally {
        if (abortPollTimer !== undefined) BgTimer.clearInterval(abortPollTimer)
      }

      if (abortSignal?.aborted) throw new Error("Sync cancelled")
      if (result.statusCode !== 200 || result.bytesWritten <= 0) {
        throw new Error(`HTTP ${result.statusCode}, ${result.bytesWritten} bytes`)
      }

      await RNFS.unlink(thumbnailPath).catch(() => {})
      await RNFS.moveFile(partialPath, thumbnailPath)
      console.log(`[ASG Camera API] Downloaded video thumbnail for ${sourceFileName}`)
      return thumbnailPath
    } catch (error) {
      await RNFS.unlink(partialPath).catch(() => {})
      if (abortSignal?.aborted || (error instanceof Error && error.message === "Sync cancelled")) {
        throw new Error("Sync cancelled")
      }
      console.warn(`[ASG Camera API] Failed to download video thumbnail for ${sourceFileName}:`, error)
      return undefined
    }
  }

  /**
   * Delete files from server
   */
  async deleteFilesFromServer(fileNames: string[]): Promise<{
    deleted: string[]
    failed: string[]
  }> {
    if (fileNames.length === 0) {
      return {deleted: [], failed: []}
    }

    try {
      const response = await this.makeRequest(
        "/api/delete-files",
        {
          method: "POST",
          body: JSON.stringify({files: fileNames}),
        },
        5,
        0,
      )

      // Parse the response format from the ASG server
      const responseData = response as any
      if (responseData.data && responseData.data.results) {
        const deleted: string[] = []
        const failed: string[] = []

        for (const result of responseData.data.results) {
          if (result.success) {
            deleted.push(result.file)
          } else {
            failed.push(result.file)
          }
        }

        console.log(`[ASG Camera API] Delete results: ${deleted.length} deleted, ${failed.length} failed`)
        return {deleted, failed}
      }

      return response as {
        deleted: string[]
        failed: string[]
      }
    } catch (error) {
      console.error("Failed to delete files from server:", error)
      return {deleted: [], failed: fileNames}
    }
  }

  /**
   * Get sync status from server
   */
  async getSyncStatus(): Promise<{
    total_files: number
    total_size: number
    last_modified: number
  }> {
    const response = await this.makeRequest("/sync/status", {
      method: "GET",
    })

    return response as {
      total_files: number
      total_size: number
      last_modified: number
    }
  }

  /**
   * Download a file from the server and save to filesystem
   */
  async downloadFile(
    filename: string,
    includeThumbnail: boolean = false,
    onProgress?: (progress: number) => void,
    abortSignal?: AbortSignal,
    expectedSize?: number,
  ): Promise<{filePath: string; thumbnailPath?: string; mime_type: string}> {
    // The legacy public shape did not require a size. Keep that rare call compatible while all
    // sync manifests use the verified resumable path below.
    if (!expectedSize || expectedSize <= 0) {
      return this.downloadFileLegacyUnsafe(filename, includeThumbnail, onProgress, abortSignal, expectedSize)
    }

    const localFilePath = localStorageService.getPhotoFilePath(filename)
    const parentDir = localFilePath.substring(0, localFilePath.lastIndexOf("/"))
    if (!(await RNFS.exists(parentDir))) await RNFS.mkdir(parentDir)
    const lowerName = filename.toLowerCase()
    const isVideo = /\.(mp4|mov|avi|webm|mkv)$/.test(lowerName)
    const captureId = filename.includes("/")
      ? filename.substring(0, filename.indexOf("/"))
      : filename.replace(/\.imu\.json$/i, "").replace(/\.[^.]+$/, "")
    const capture: CaptureGroup = {
      capture_id: captureId,
      type: isVideo ? "video" : "photo",
      timestamp: Date.now(),
      total_size: expectedSize,
      files: [{name: filename, size: expectedSize, role: "primary"}],
    }
    const capabilities = await this.getGalleryCapabilities()
    galleryTransferLedger.ensureCapture(capture, capabilities?.api_version || 1)
    galleryTransferLedger.transition(captureId, "TRANSFERRING")
    try {
      await this.downloadResumableCaptureFile(
        captureId,
        capture.files[0],
        localFilePath,
        (bytes) => onProgress?.(Math.min(100, Math.round((bytes / expectedSize) * 100))),
        abortSignal,
      )
      await validateDownloadedMediaFile({
        path: localFilePath,
        name: filename,
        expectedSize,
        mediaKind: isVideo ? "video" : "photo",
      })
      galleryTransferLedger.transition(captureId, "VERIFIED")
      const thumbnailPath =
        includeThumbnail && isVideo
          ? await this.downloadVideoThumbnail(filename, localStorageService.getThumbnailFilePath(filename), abortSignal)
          : undefined
      return {
        filePath: localFilePath,
        thumbnailPath,
        mime_type: isVideo
          ? "video/mp4"
          : lowerName.endsWith(".png")
            ? "image/png"
            : lowerName.endsWith(".avif")
              ? "image/avif"
              : "image/jpeg",
      }
    } catch (error) {
      galleryTransferLedger.recordFailure(captureId, error)
      throw error
    }
  }

  private async downloadFileLegacyUnsafe(
    filename: string,
    includeThumbnail: boolean = false,
    onProgress?: (progress: number) => void,
    abortSignal?: AbortSignal,
    expectedSize?: number,
  ): Promise<{
    filePath: string
    thumbnailPath?: string
    mime_type: string
  }> {
    console.log(`[ASG Camera API] Downloading file: ${filename}`)

    try {
      // Get the local file path where we'll save this
      const localFilePath = localStorageService.getPhotoFilePath(filename)
      const localThumbnailPath = includeThumbnail ? localStorageService.getThumbnailFilePath(filename) : undefined

      // Ensure parent directory exists (for folder-based capture paths like IMG_xxx/base.jpg)
      if (filename.includes("/")) {
        const parentDir = localFilePath.substring(0, localFilePath.lastIndexOf("/"))
        const parentExists = await RNFS.exists(parentDir)
        if (!parentExists) {
          await RNFS.mkdir(parentDir)
        }
      }

      // Determine if this is a video file based on extension
      const isVideo = filename.match(/\.(mp4|mov|avi|webm|mkv)$/i)

      // Use /api/download for videos (full file) and /api/photo for images
      const downloadEndpoint = isVideo ? "download" : "photo"
      const downloadUrl = `${this.baseUrl}/api/${downloadEndpoint}?file=${encodeURIComponent(filename)}`

      // Download the file directly to filesystem
      console.log(`[ASG Camera API] Downloading ${isVideo ? "video" : "photo"} from: ${downloadUrl}`)
      console.log(`[ASG Camera API] Saving to: ${localFilePath}`)

      // Track content length from begin callback for post-download validation
      let expectedContentLength = 0
      // Throttle progress: only call onProgress when percentage actually changes
      let lastReportedProgress = -1

      const {jobId, promise: downloadPromise} = localNetworkTransport.downloadFile({
        fromUrl: downloadUrl,
        toFile: localFilePath,
        headers: {
          "Accept": "*/*",
          "User-Agent": "MentraOS-Mobile/1.0",
        },
        connectionTimeout: 300000, // 5 minutes for connection establishment
        readTimeout: 300000, // 5 minutes for data reading
        backgroundTimeout: 600000, // 10 minutes for background downloads (iOS)
        progressDivider: 5, // Fire progress every 5% to reduce event frequency
        progressInterval: 250, // Update progress every 250ms max
        begin: (res) => {
          expectedContentLength = res.contentLength || 0
          console.log(`[ASG Camera API] Download started for ${filename}, size: ${res.contentLength}`)
        },
        progress: (res) => {
          // Validate progress data to prevent negative percentages
          const contentLength = res.contentLength || 0
          const bytesWritten = res.bytesWritten || 0

          let percentage = 0
          if (contentLength > 0 && bytesWritten >= 0) {
            percentage = Math.round((bytesWritten / contentLength) * 100)
            // Clamp percentage between 0 and 100
            percentage = Math.max(0, Math.min(100, percentage))
          }

          // Only call onProgress when percentage actually changes (throttle)
          if (onProgress && percentage !== lastReportedProgress) {
            lastReportedProgress = percentage
            onProgress(percentage)
          }

          // Log every 10%
          if (percentage % 10 === 0) {
            console.log(`[ASG Camera API] Download progress ${filename}: ${percentage}%`)
          }
        },
      })

      // Wire up abort signal to stop download via polling (safe for all Hermes versions)
      let abortPollTimer: number | undefined
      if (abortSignal) {
        if (abortSignal.aborted) {
          localNetworkTransport.stopDownload(jobId)
          throw new Error("Sync cancelled")
        }
        abortPollTimer = BgTimer.setInterval(() => {
          if (abortSignal.aborted) {
            localNetworkTransport.stopDownload(jobId)
          }
        }, 500)
      }

      let downloadResult
      try {
        downloadResult = await downloadPromise
      } finally {
        if (abortPollTimer !== undefined) BgTimer.clearInterval(abortPollTimer)
      }

      if (downloadResult.statusCode !== 200) {
        // S2: Clean up partial file on HTTP error
        await RNFS.unlink(localFilePath).catch(() => {})
        throw new Error(`Failed to download ${filename}: HTTP ${downloadResult.statusCode}`)
      }

      // Check if download was aborted after completion
      if (abortSignal?.aborted) {
        await RNFS.unlink(localFilePath).catch(() => {})
        throw new Error("Sync cancelled")
      }

      // N1: Validate file size after download.
      // Use Content-Length from the HTTP response if available, otherwise fall back
      // to expectedSize from the sync response metadata. This catches truncated
      // downloads even when the server uses chunked transfer encoding (no Content-Length).
      const sizeToCheck =
        expectedContentLength > 0 ? expectedContentLength : expectedSize && expectedSize > 0 ? expectedSize : 0

      try {
        await validateDownloadedMediaFile({
          path: localFilePath,
          name: filename,
          expectedSize: sizeToCheck,
          mediaKind: isVideo ? "video" : "photo",
        })
      } catch (validationErr: any) {
        const reason = validationErr?.message || validationErr?.toString?.() || JSON.stringify(validationErr)
        reportInvalidGalleryMedia({
          name: filename,
          path: localFilePath,
          mediaKind: isVideo ? "video" : "photo",
          stage: "download_validation",
          reason,
          expectedSize: sizeToCheck,
        })
        await RNFS.unlink(localFilePath).catch(() => {})
        throw validationErr
      }

      console.log(`[ASG Camera API] Successfully downloaded ${filename} to filesystem`)

      // Detect MIME type by checking file signature
      let mimeType = "application/octet-stream"
      try {
        // Read first 20 bytes to check file signature
        const firstBytes = await RNFS.read(localFilePath, 20, 0, "base64")
        const decodedBytes = atob(firstBytes)

        // Check for AVIF signature
        if (decodedBytes.length > 11) {
          const ftypSignature = decodedBytes.substring(4, 12)
          if (ftypSignature === "ftypavif") {
            mimeType = "image/avif"
            console.log(`[ASG Camera API] Detected AVIF file: ${filename}`)
          } else if (decodedBytes.substring(0, 2) === "\xFF\xD8") {
            mimeType = "image/jpeg"
          } else if (decodedBytes.substring(0, 8) === "\x89PNG\r\n\x1a\n") {
            mimeType = "image/png"
          }
        }

        // Also check by extension
        if (mimeType === "application/octet-stream") {
          if (filename.toLowerCase().endsWith(".jpg") || filename.toLowerCase().endsWith(".jpeg")) {
            mimeType = "image/jpeg"
          } else if (filename.toLowerCase().endsWith(".png")) {
            mimeType = "image/png"
          } else if (filename.toLowerCase().endsWith(".mp4")) {
            mimeType = "video/mp4"
          } else if (!filename.includes(".")) {
            // Files without extension are likely AVIF
            mimeType = "image/avif"
          }
        }
      } catch (e) {
        console.warn(`[ASG Camera API] Could not detect MIME type for ${filename}:`, e)
      }

      // Download thumbnail if requested and it's a video
      let thumbnailPath: string | undefined
      if (includeThumbnail && filename.toLowerCase().match(/\.(mp4|mov|avi|mkv|webm)$/)) {
        try {
          console.log(`[ASG Camera API] Downloading thumbnail for ${filename}`)
          console.log(`[ASG Camera API] Using /api/photo endpoint for video thumbnail`)

          // The server's /api/photo endpoint serves thumbnails for video files
          // It detects video files and automatically generates/serves thumbnails instead of the full video
          const thumbResult = await localNetworkTransport.downloadFile({
            fromUrl: `${this.baseUrl}/api/photo?file=${encodeURIComponent(filename)}`,
            toFile: localThumbnailPath as string,
            headers: {
              "Accept": "image/*",
              "User-Agent": "MentraOS-Mobile/1.0",
            },
            connectionTimeout: 60000, // 1 minute for thumbnails (smaller files)
            readTimeout: 60000, // 1 minute for thumbnails
            progressDivider: 1, // Get all progress updates for thumbnails too
            begin: (res) => {
              console.log(`[ASG Camera API] Thumbnail download started for ${filename}, size: ${res.contentLength}`)
            },
            progress: (res) => {
              const percentage = Math.round((res.bytesWritten / res.contentLength) * 100)
              if (percentage % 25 === 0) {
                console.log(`[ASG Camera API] Thumbnail download progress ${filename}: ${percentage}%`)
              }
            },
          }).promise

          console.log(
            `[ASG Camera API] Thumbnail download result for ${filename}: status=${thumbResult.statusCode}, bytesWritten=${thumbResult.bytesWritten}`,
          )

          if (thumbResult.statusCode === 200) {
            thumbnailPath = localThumbnailPath as string
            console.log(`[ASG Camera API] Successfully downloaded thumbnail to: ${thumbnailPath}`)

            // Verify the file exists
            const exists = await RNFS.exists(thumbnailPath)
            console.log(`[ASG Camera API] Thumbnail file exists: ${exists}`)
          } else {
            console.warn(`[ASG Camera API] Thumbnail download failed with status: ${thumbResult.statusCode}`)
          }
        } catch (error) {
          console.warn(`[ASG Camera API] Failed to download thumbnail for ${filename}:`, error)
        }
      } else {
        console.log(
          `[ASG Camera API] Skipping thumbnail download - includeThumbnail: ${includeThumbnail}, filename: ${filename}, is video extension: ${
            filename.toLowerCase().match(/\.(mp4|mov|avi|mkv|webm)$/) ? "yes" : "no"
          }`,
        )
      }

      return {
        filePath: localFilePath,
        thumbnailPath: thumbnailPath,
        mime_type: mimeType,
      }
    } catch (error) {
      console.error(`[ASG Camera API] Error downloading file ${filename}:`, error)
      // S2: Clean up partial file on any failure
      const localFilePath = localStorageService.getPhotoFilePath(filename)
      await RNFS.unlink(localFilePath).catch(() => {})
      throw error
    }
  }
}

// Export a default instance - will be initialized with proper IP when used
export const asgCameraApi = new AsgCameraApiClient()
