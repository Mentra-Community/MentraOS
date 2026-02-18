/**
 * @fileoverview UDP Crypto utility for encrypted audio packets.
 *
 * Uses tweetnacl secretbox (XSalsa20-Poly1305) for symmetric authenticated encryption.
 *
 * Simplified key exchange flow (symmetric key via TLS):
 * 1. Server generates random 32-byte symmetric key on session start
 * 2. Server sends key to client in CONNECTION_ACK (over TLS-encrypted WebSocket)
 * 3. Client uses key to encrypt audio with secretbox
 * 4. Server decrypts with same key
 *
 * This is secure because:
 * - Key is transmitted over TLS (WebSocket connection)
 * - Each session gets a unique key
 * - XSalsa20-Poly1305 provides encryption + authentication
 * - Keys are garbage collected when session ends
 *
 * Encrypted packet format:
 * [userIdHash(4)|seq(2)|nonce(24)|ciphertext(audio + 16 bytes tag)]
 *
 * Overhead: 24 bytes nonce + 16 bytes auth tag = 40 bytes per packet
 */

import nacl from "tweetnacl";

/** Nonce size for XSalsa20-Poly1305 (24 bytes) */
export const NONCE_SIZE = nacl.secretbox.nonceLength; // 24

/** Auth tag size for Poly1305 (16 bytes) */
export const TAG_SIZE = nacl.secretbox.overheadLength; // 16

/** Symmetric key size (32 bytes) */
export const KEY_SIZE = nacl.secretbox.keyLength; // 32

/** Total overhead per encrypted packet */
export const ENCRYPTION_OVERHEAD = NONCE_SIZE + TAG_SIZE; // 40 bytes

/**
 * Generate a random 32-byte symmetric key for a session
 */
export function generateKey(): Uint8Array {
  return nacl.randomBytes(KEY_SIZE);
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
  const nonce = nacl.randomBytes(NONCE_SIZE);
  const ciphertext = nacl.secretbox(plaintext, nonce, key);

  // Combine nonce + ciphertext
  const result = new Uint8Array(NONCE_SIZE + ciphertext.length);
  result.set(nonce, 0);
  result.set(ciphertext, NONCE_SIZE);

  return result;
}

/**
 * Decrypt audio data using symmetric key.
 * Input should be [nonce(24)|ciphertext(...)].
 *
 * @param encryptedData Buffer containing [nonce(24)|ciphertext]
 * @param key 32-byte symmetric key
 * @returns Decrypted audio data, or null if decryption fails (tampered/wrong key)
 */
export function decrypt(encryptedData: Uint8Array, key: Uint8Array): Uint8Array | null {
  if (encryptedData.length < NONCE_SIZE + TAG_SIZE) {
    return null; // Too short to contain nonce + tag
  }

  const nonce = encryptedData.slice(0, NONCE_SIZE);
  const ciphertext = encryptedData.slice(NONCE_SIZE);

  return nacl.secretbox.open(ciphertext, nonce, key);
}

/**
 * Encode key to base64 for transmission in JSON messages
 */
export function encodeKey(key: Uint8Array): string {
  return Buffer.from(key).toString("base64");
}

/**
 * Decode base64 key from JSON messages
 * @returns Key bytes, or null if invalid
 */
export function decodeKey(base64Key: string): Uint8Array | null {
  try {
    const bytes = Buffer.from(base64Key, "base64");
    if (bytes.length !== KEY_SIZE) {
      return null;
    }
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}

/**
 * Session encryption state - stored in UdpAudioManager
 */
export interface UdpEncryptionState {
  /** Whether encryption is enabled for this session */
  enabled: boolean;
  /** Symmetric key for this session (32 bytes) */
  key: Uint8Array;
}

/**
 * Create encryption state for a session that requested encryption
 */
export function createEncryptionState(): UdpEncryptionState {
  return {
    enabled: true,
    key: generateKey(),
  };
}
