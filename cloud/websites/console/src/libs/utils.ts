// import * as React from "react"
import {clsx, type ClassValue} from "clsx"
import {twMerge} from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Normalize and enhance a URL by handling common issues:
 * - Adds https:// if no protocol is specified
 * - Upgrades http:// to https://
 * - Removes trailing slashes
 *
 * @param url The URL to normalize
 * @returns The normalized and enhanced URL
 */
export function normalizeUrl(url: string): string {
  if (!url) return url

  // Trim whitespace
  let normalizedUrl = url.trim()

  // Add https:// if no protocol is specified
  if (!normalizedUrl.includes("://")) {
    normalizedUrl = "https://" + normalizedUrl
  }

  // Replace http:// with https://
  if (normalizedUrl.startsWith("http://")) {
    normalizedUrl = "https://" + normalizedUrl.substring(7)
  }

  // Remove trailing slashes
  return normalizedUrl.replace(/\/+$/, "")
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const isUserInstalledApp = (userID: string, appPkgName: string): boolean => {
  console.log(`Checking if ${userID} does have ${appPkgName} installed?`)
  return true
}
