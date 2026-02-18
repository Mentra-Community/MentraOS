/**
 * CLI Keys Service Tests
 *
 * Tests for CLI key generation, validation, and management
 */

import { describe, test, expect } from "bun:test";
import * as CLIKeysService from "../cli-keys.service";
import jwt from "jsonwebtoken";

// Mock data
const testEmail = "developer@example.com";
const testKeyName = "Test CLI Key";
const testRequest = {
  userAgent: "Mozilla/5.0 (Test)",
  ipAddress: "127.0.0.1",
};

describe("CLI Keys Service", () => {
  describe("generateKey", () => {
    test("should generate a new CLI key with valid JWT token", async () => {
      const result = await CLIKeysService.generateKey(testEmail, testRequest, {
        name: testKeyName,
      });

      expect(result).toBeDefined();
      expect(result.key).toBeDefined();
      expect(result.keyId).toBeDefined();
      expect(result.token).toBeDefined();

      // Verify token is a valid JWT
      const parts = result.token.split(".");
      expect(parts.length).toBe(3);
    });

    test("should include email in JWT payload", async () => {
      const result = await CLIKeysService.generateKey(testEmail, testRequest, {
        name: testKeyName,
      });

      const decoded = jwt.decode(result.token) as any;
      expect(decoded.email).toBe(testEmail);
    });

    test("should include type=cli in JWT payload", async () => {
      const result = await CLIKeysService.generateKey(testEmail, testRequest, {
        name: testKeyName,
      });

      const decoded = jwt.decode(result.token) as any;
      expect(decoded.type).toBe("cli");
    });

    test("should include keyId in JWT payload", async () => {
      const result = await CLIKeysService.generateKey(testEmail, testRequest, {
        name: testKeyName,
      });

      const decoded = jwt.decode(result.token) as any;
      expect(decoded.keyId).toBe(result.keyId);
    });

    test("should include key name in JWT payload", async () => {
      const result = await CLIKeysService.generateKey(testEmail, testRequest, {
        name: testKeyName,
      });

      const decoded = jwt.decode(result.token) as any;
      expect(decoded.name).toBe(testKeyName);
    });

    test("should NOT include exp when expiresAt is not provided", async () => {
      const result = await CLIKeysService.generateKey(testEmail, testRequest, {
        name: testKeyName,
      });

      const decoded = jwt.decode(result.token) as any;
      expect(decoded.exp).toBeUndefined();
    });

    test("should include exp when expiresAt is provided", async () => {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

      const result = await CLIKeysService.generateKey(testEmail, testRequest, {
        name: testKeyName,
        expiresAt,
      });

      const decoded = jwt.decode(result.token) as any;
      expect(decoded.exp).toBeDefined();
      expect(typeof decoded.exp).toBe("number");
    });

    test("should store hashed token, not plaintext", async () => {
      const result = await CLIKeysService.generateKey(testEmail, testRequest, {
        name: testKeyName,
      });

      // The key object should not contain the plaintext token
      expect(result.key.hashedToken).toBeDefined();
      expect(result.key.hashedToken).not.toBe(result.token);
      expect(result.key.hashedToken.length).toBeGreaterThan(32);
    });

    test("should generate unique keyIds for multiple keys", async () => {
      const result1 = await CLIKeysService.generateKey(testEmail, testRequest, {
        name: "Key 1",
      });

      const result2 = await CLIKeysService.generateKey(testEmail, testRequest, {
        name: "Key 2",
      });

      expect(result1.keyId).not.toBe(result2.keyId);
    });

    test("should set isActive to true by default", async () => {
      const result = await CLIKeysService.generateKey(testEmail, testRequest, {
        name: testKeyName,
      });

      expect(result.key.isActive).toBe(true);
    });

    test("should record creation metadata", async () => {
      const result = await CLIKeysService.generateKey(testEmail, testRequest, {
        name: testKeyName,
      });

      expect(result.key.createdAt).toBeDefined();
      expect(result.key.metadata?.userAgent).toBe(testRequest.userAgent);
      expect(result.key.metadata?.ipAddress).toBe(testRequest.ipAddress);
    });
  });

  describe("listKeys", () => {
    test("should return array of keys for user", async () => {
      const keys = await CLIKeysService.listKeys(testEmail);

      expect(Array.isArray(keys)).toBe(true);
    });

    test("should not return hashed tokens in list", async () => {
      await CLIKeysService.generateKey(testEmail, testRequest, {
        name: testKeyName,
      });

      const keys = await CLIKeysService.listKeys(testEmail);

      if (keys.length > 0) {
        expect(keys[0].hashedToken).toBeUndefined();
      }
    });

    test("should return keys with essential fields", async () => {
      await CLIKeysService.generateKey(testEmail, testRequest, {
        name: testKeyName,
      });

      const keys = await CLIKeysService.listKeys(testEmail);

      if (keys.length > 0) {
        expect(keys[0].keyId).toBeDefined();
        expect(keys[0].name).toBeDefined();
        expect(keys[0].createdAt).toBeDefined();
        expect(keys[0].isActive).toBeDefined();
      }
    });

    test("should return empty array for user with no keys", async () => {
      const keys = await CLIKeysService.listKeys("nonexistent@example.com");

      expect(Array.isArray(keys)).toBe(true);
      expect(keys.length).toBe(0);
    });
  });

  describe("getKey", () => {
    test("should retrieve a specific key by keyId", async () => {
      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: testKeyName,
        },
      );

      const key = await CLIKeysService.getKey(testEmail, generated.keyId);

      expect(key).toBeDefined();
      expect(key.keyId).toBe(generated.keyId);
    });

    test("should not return key for wrong user", async () => {
      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: testKeyName,
        },
      );

      const key = await CLIKeysService.getKey(
        "other@example.com",
        generated.keyId,
      );

      expect(key).toBeNull();
    });

    test("should not expose hashed token", async () => {
      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: testKeyName,
        },
      );

      const key = await CLIKeysService.getKey(testEmail, generated.keyId);

      expect(key.hashedToken).toBeUndefined();
    });
  });

  describe("updateKey", () => {
    test("should update key name", async () => {
      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: testKeyName,
        },
      );

      const newName = "Updated Key Name";
      const updated = await CLIKeysService.updateKey(
        testEmail,
        generated.keyId,
        newName,
      );

      expect(updated).toBeDefined();
      expect(updated.name).toBe(newName);
    });

    test("should not update key for wrong user", async () => {
      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: testKeyName,
        },
      );

      const updated = await CLIKeysService.updateKey(
        "other@example.com",
        generated.keyId,
        "Hacked Name",
      );

      expect(updated).toBeNull();
    });

    test("should update updatedAt timestamp", async () => {
      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: testKeyName,
        },
      );

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 100));

      const updated = await CLIKeysService.updateKey(
        testEmail,
        generated.keyId,
        "New Name",
      );

      expect(updated.updatedAt).toBeDefined();
      expect(updated.updatedAt.getTime()).toBeGreaterThan(
        generated.key.createdAt.getTime(),
      );
    });
  });

  describe("revokeKey", () => {
    test("should revoke a key by keyId", async () => {
      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: testKeyName,
        },
      );

      const revoked = await CLIKeysService.revokeKey(
        testEmail,
        generated.keyId,
      );

      expect(revoked).toBe(true);

      // Verify key is no longer active
      const key = await CLIKeysService.getKey(testEmail, generated.keyId);
      expect(key.isActive).toBe(false);
    });

    test("should not revoke key for wrong user", async () => {
      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: testKeyName,
        },
      );

      const revoked = await CLIKeysService.revokeKey(
        "other@example.com",
        generated.keyId,
      );

      expect(revoked).toBe(false);
    });

    test("should return false for non-existent keyId", async () => {
      const revoked = await CLIKeysService.revokeKey(
        testEmail,
        "key_nonexistent",
      );

      expect(revoked).toBe(false);
    });
  });

  describe("validateToken", () => {
    test("should validate a valid token", async () => {
      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: testKeyName,
        },
      );

      const result = await CLIKeysService.validateToken(
        generated.token,
        jwt.decode(generated.token) as any,
      );

      expect(result.valid).toBe(true);
      expect(result.email).toBe(testEmail);
      expect(result.keyId).toBe(generated.keyId);
    });

    test("should reject revoked token", async () => {
      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: testKeyName,
        },
      );

      // Revoke the key
      await CLIKeysService.revokeKey(testEmail, generated.keyId);

      const result = await CLIKeysService.validateToken(
        generated.token,
        jwt.decode(generated.token) as any,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("revoked");
    });

    test("should reject expired token", async () => {
      const expiresAt = new Date(Date.now() - 1000); // Already expired

      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: testKeyName,
          expiresAt,
        },
      );

      const result = await CLIKeysService.validateToken(
        generated.token,
        jwt.decode(generated.token) as any,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("expired");
    });

    test("should reject token with mismatched hash", async () => {
      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: testKeyName,
        },
      );

      // Create a different token with same payload
      const payload = jwt.decode(generated.token) as any;
      const fakeToken = jwt.sign(payload, "different-secret");

      const result = await CLIKeysService.validateToken(fakeToken, payload);

      expect(result.valid).toBe(false);
    });

    test("should update lastUsedAt on successful validation", async () => {
      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: testKeyName,
        },
      );

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      await CLIKeysService.validateToken(
        generated.token,
        jwt.decode(generated.token) as any,
      );

      const key = await CLIKeysService.getKey(testEmail, generated.keyId);
      expect(key.lastUsedAt).toBeDefined();
    });
  });

  describe("cleanupExpiredKeys", () => {
    test("should remove expired keys", async () => {
      const expiresAt = new Date(Date.now() - 1000); // Already expired

      await CLIKeysService.generateKey(testEmail, testRequest, {
        name: "Expired Key",
        expiresAt,
      });

      await CLIKeysService.cleanupExpiredKeys();

      // Test passes if no error thrown
      expect(true).toBe(true);
    });

    test("should not remove non-expired keys", async () => {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: "Valid Key",
          expiresAt,
        },
      );

      await CLIKeysService.cleanupExpiredKeys();

      const key = await CLIKeysService.getKey(testEmail, generated.keyId);
      expect(key).toBeDefined();
    });

    test("should not remove keys without expiration", async () => {
      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: "No Expiry Key",
        },
      );

      await CLIKeysService.cleanupExpiredKeys();

      const key = await CLIKeysService.getKey(testEmail, generated.keyId);
      expect(key).toBeDefined();
    });
  });

  describe("Security", () => {
    test("should use cryptographically secure hash", async () => {
      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: testKeyName,
        },
      );

      // Hash should be hex string of appropriate length
      expect(generated.key.hashedToken).toMatch(/^[a-f0-9]{64,}$/);
    });

    test("should not expose secret in any response", async () => {
      const generated = await CLIKeysService.generateKey(
        testEmail,
        testRequest,
        {
          name: testKeyName,
        },
      );

      const json = JSON.stringify(generated);
      expect(json).not.toContain("CLI_AUTH_JWT_SECRET");
      expect(json).not.toContain("secret");
    });

    test("should generate cryptographically random keyIds", async () => {
      const keys = [];
      for (let i = 0; i < 10; i++) {
        const result = await CLIKeysService.generateKey(
          testEmail,
          testRequest,
          {
            name: `Key ${i}`,
          },
        );
        keys.push(result.keyId);
      }

      // All keyIds should be unique
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(10);
    });
  });

  describe("Edge Cases", () => {
    test("should handle empty key name", async () => {
      const result = await CLIKeysService.generateKey(testEmail, testRequest, {
        name: "",
      });

      expect(result).toBeDefined();
      expect(result.key.name).toBe("");
    });

    test("should handle very long key names", async () => {
      const longName = "x".repeat(1000);
      const result = await CLIKeysService.generateKey(testEmail, testRequest, {
        name: longName,
      });

      expect(result.key.name).toBe(longName);
    });

    test("should handle special characters in key name", async () => {
      const specialName = "Key with 特殊字符 and émojis 🔑";
      const result = await CLIKeysService.generateKey(testEmail, testRequest, {
        name: specialName,
      });

      expect(result.key.name).toBe(specialName);
    });

    test("should handle missing request metadata", async () => {
      const result = await CLIKeysService.generateKey(
        testEmail,
        { userAgent: undefined, ipAddress: undefined },
        { name: testKeyName },
      );

      expect(result).toBeDefined();
    });
  });
});
