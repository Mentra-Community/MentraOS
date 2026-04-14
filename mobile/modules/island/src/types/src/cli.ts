/**
 * CLI API Key Management Types
 *
 * Shared between cloud backend and CLI tool.
 */

/**
 * CLI API Key stored in database
 */
export interface CLIApiKey {
  /** Unique key identifier (UUID v4) */
  keyId: string

  /** User ID who owns this key (ObjectId as string) */
  userId: string

  /** User email (denormalized for backward compatibility) */
  email: string

  /** User-friendly name for the key */
  name: string

  /** SHA-256 hash of the JWT token (for revocation checks) */
  hashedToken: string

  /** When the key was created */
  createdAt: Date

  /** When the key was last updated */
  updatedAt: Date

  /** Last time this key was used (optional tracking) */
  lastUsedAt?: Date

  /** Optional expiration date */
  expiresAt?: Date

  /** Whether key is active (false = revoked) */
  isActive: boolean

  /** Optional metadata */
  metadata?: {
    createdFrom?: string
    userAgent?: string
  }
}

/**
 * Request to generate a new CLI API key
 */
export interface GenerateCLIKeyRequest {
  /** User-friendly name for the key */
  name: string

  /** Optional expiration in days (default: never) */
  expiresInDays?: number
}

/**
 * Response when generating a CLI API key
 * Token is shown ONCE and never retrievable
 */
export interface GenerateCLIKeyResponse {
  /** The CLI API key ID */
  keyId: string

  /** User-friendly name */
  name: string

  /** JWT token (ONLY shown once!) */
  token: string

  /** When it was created */
  createdAt: string

  /** Optional expiration date */
  expiresAt?: string
}

/**
 * CLI API Key list item (token not included)
 */
export interface CLIApiKeyListItem {
  /** Key identifier */
  keyId: string

  /** User-friendly name */
  name: string

  /** Creation timestamp */
  createdAt: string

  /** Last usage timestamp (if tracked) */
  lastUsedAt?: string

  /** Expiration timestamp */
  expiresAt?: string

  /** Whether key is active */
  isActive: boolean
}

/**
 * Request to update a CLI API key
 */
export interface UpdateCLIKeyRequest {
  /** New name for the key */
  name: string
}

/**
 * JWT payload for CLI API keys
 */
export interface CLITokenPayload {
  /** User email */
  email: string

  /** Token type discriminator */
  type: "cli"

  /** Key ID for revocation lookups */
  keyId: string

  /** User-friendly key name */
  name: string

  /** Issued at (Unix timestamp) */
  iat: number

  /** Optional expiration (Unix timestamp) */
  exp?: number
}

/**
 * CLI credentials stored locally on user's machine
 */
export interface CLICredentials {
  /** JWT token */
  token: string

  /** User email (extracted from token) */
  email: string

  /** Key name (extracted from token) */
  keyName: string

  /** Key ID (extracted from token) */
  keyId: string

  /** When credentials were stored */
  storedAt: string

  /** Optional expiration timestamp */
  expiresAt?: string
}

/**
 * Cloud environment configuration
 */
export interface Cloud {
  /** Display name */
  name: string

  /** API URL */
  url: string

  /** Whether this is a built-in cloud */
  builtin?: boolean
}
