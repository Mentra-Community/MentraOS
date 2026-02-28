/**
 * @fileoverview UDP Crypto utility for encrypted audio packets (mobile side).
 *
 * Uses tweetnacl secretbox (XSalsa20-Poly1305) for symmetric authenticated encryption.
 *
 * Flow:
 * 1. Server sends symmetric key in CONNECTION_ACK (over TLS-encrypted WebSocket)
 * 2. Mobile stores key and uses it to encrypt all UDP audio packets
 * 3. Server decrypts with same key
 *
 * Encrypted packet format:
 * [userIdHash(4)|seq(2)|nonce(24)|ciphertext(audio + 16 bytes tag)]
 *
 * Overhead: 24 bytes nonce + 16 bytes auth tag = 40 bytes per packet
 */

import {Buffer} from "buffer"
import nacl from "tweetnacl"

/** Nonce size for XSalsa20-Poly1305 (24 bytes) */
export const NONCE_SIZE = nacl.secretbox.nonceLength // 24

/** Auth tag size for Poly1305 (16 bytes) */
export const TAG_SIZE = nacl.secretbox.overheadLength // 16

/** Symmetric key size (32 bytes) */
export const KEY_SIZE = nacl.secretbox.keyLength // 32

/** Total overhead per encrypted packet */
export const ENCRYPTION_OVERHEAD = NONCE_SIZE + TAG_SIZE // 40 bytes

/**
 * Decode base64 key from CONNECTION_ACK
 * @returns Key bytes, or null if invalid
 */
export function decodeKey(base64Key: string): Uint8Array | null {
  try {
    const bytes = Buffer.from(base64Key, "base64")
    if (bytes.length !== KEY_SIZE) {
      console.log(`UdpCrypto: Invalid key length ${bytes.length}, expected ${KEY_SIZE}`)
      return null
    }
    return new Uint8Array(bytes)
  } catch (e) {
    console.log(`UdpCrypto: Failed to decode key: ${e}`)
    return null
  }
}

/**
 * Encrypt audio data using symmetric key.
 * Returns nonce + ciphertext (which includes 16-byte auth tag).
 *
 * @param plaintext Audio data to encrypt
 * @param key 32-byte symmetric key
 * @returns Buffer containing [nonce(24)|ciphertext(plaintext.length + 16)]
 */
export function encrypt(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(NONCE_SIZE)
  const ciphertext = nacl.secretbox(plaintext, nonce, key)

  // Combine nonce + ciphertext
  const result = new Uint8Array(NONCE_SIZE + ciphertext.length)
  result.set(nonce, 0)
  result.set(ciphertext, NONCE_SIZE)

  return result
}

/**
 * Encryption state for UdpManager
 */
export interface UdpEncryptionConfig {
  /** Whether encryption is enabled */
  enabled: boolean
  /** Symmetric key (32 bytes) */
  key: Uint8Array
}

/**
 * Create encryption config from CONNECTION_ACK data
 */
export function createEncryptionConfig(base64Key: string): UdpEncryptionConfig | null {
  const key = decodeKey(base64Key)
  if (!key) {
    return null
  }
  return {
    enabled: true,
    key,
  }
}
