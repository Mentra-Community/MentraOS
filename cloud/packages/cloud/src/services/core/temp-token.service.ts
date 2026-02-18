// src/services/core/token.service.ts
import crypto from "crypto";
import { TempToken, ITempToken } from "../../models/temp-token.model";
import { logger as rootLogger } from "../logging";
import { SignJWT, importPKCS8 } from "jose";
import { appService } from "./app.service";

const logger = rootLogger.child({ service: "temp-token.service" });

// Environment variable for JWT signing
export const APP_AUTH_JWT_PRIVATE_KEY: string | null =
  process.env.APP_AUTH_JWT_PRIVATE_KEY ||
  process.env.TPA_AUTH_JWT_PRIVATE_KEY ||
  null;
if (!APP_AUTH_JWT_PRIVATE_KEY) {
  console.warn("[token.service] APP_AUTH_JWT_PRIVATE_KEY is not set");
}

/**
 * Interface for the result of exchanging a temporary token
 */
interface ExchangeTokenResult {
  userId: string;
}

/**
 * Service for managing temporary tokens and user authentication tokens.
 * Handles token generation, exchange, and JWT signing operations.
 */
export class TokenService {
  /**
   * Generates a secure temporary token and stores it in the database.
   * The token expires after 60 seconds and can only be used once.
   *
   * @param userId - The user ID associated with the token
   * @param packageName - The package name of the App this token is intended for
   * @returns Promise resolving to the generated temporary token string
   * @throws Error if token generation or storage fails
   */
  async generateTemporaryToken(
    userId: string,
    packageName: string,
  ): Promise<string> {
    const logger = rootLogger.child({
      service: "temp-token.service",
      userId,
      packageName,
    });

    // Generate a cryptographically secure random token
    const token: string = crypto.randomBytes(32).toString("hex");

    const tempTokenDoc = new TempToken({
      token,
      userId,
      packageName,
      createdAt: new Date(), // Explicitly set createdAt for clarity, though default works
      // Note: MongoDB TTL index handles expiration based on 'createdAt' field
    });

    try {
      await tempTokenDoc.save();
      logger.info(
        `Generated temporary token for user ${userId} and package ${packageName}`,
      );
      return token;
    } catch (error) {
      {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(
          err,
          `Error saving temporary token for user ${userId}, package ${packageName}:`,
        );
      }
      throw new Error("Failed to generate temporary token");
    }
  }

  /**
   * Exchanges a temporary token for the associated user ID, validating the requesting App.
   * Performs multiple security checks:
   * - Token existence and validity
   * - Single-use enforcement (marks token as used)
   * - Expiration check (60-second TTL)
   * - Package name validation (prevents cross-App token usage)
   *
   * @param tempToken - The temporary token string to exchange
   * @param requestingPackageName - The package name of the App making the exchange request
   * @returns Promise resolving to an object containing the userId if valid, null otherwise
   */
  async exchangeTemporaryToken(
    tempToken: string,
    requestingPackageName: string,
  ): Promise<ExchangeTokenResult | null> {
    const logger = rootLogger.child({
      service: "temp-token.service",
      requestingPackageName,
      tempToken,
    });
    try {
      const tokenDoc: ITempToken | null = await TempToken.findOne({
        token: tempToken,
      });

      if (!tokenDoc) {
        logger.warn(`Temporary token not found: ${tempToken}`);
        return null; // Token doesn't exist
      }

      if (tokenDoc.used) {
        logger.warn(`Temporary token already used: ${tempToken}`);
        return null; // Token already used
      }

      // Check if the token has expired (TTL index should handle this, but double-check)
      const now: Date = new Date();
      const createdAt: Date = new Date(tokenDoc.createdAt);
      const tokenAgeInMs: number = now.getTime() - createdAt.getTime();

      if (tokenAgeInMs > 60000) {
        // 60 seconds TTL
        logger.warn(`Temporary token expired: ${tempToken}`);
        // Optionally delete the expired token here if TTL isn't reliable enough
        // await TempToken.deleteOne({ token: tempToken });
        return null;
      }

      // **Crucial Security Check:** Verify the requesting App matches the one the token was issued for.
      if (tokenDoc.packageName !== requestingPackageName) {
        logger.error(
          `Token mismatch: Token for ${tokenDoc.packageName} used by ${requestingPackageName}`,
        );
        return null; // Token not intended for this application
      }

      // Mark the token as used to prevent replay attacks
      tokenDoc.used = true;
      await tokenDoc.save();

      logger.info(
        `Successfully exchanged temporary token for user ${tokenDoc.userId}, requested by ${requestingPackageName}`,
      );
      return { userId: tokenDoc.userId };
    } catch (error) {
      {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(err, `Error exchanging temporary token ${tempToken}:`);
      }
      return null; // Return null on any error during exchange
    }
  }

  /**
   * Issues a signed JWT token for AugmentOS users to be used in App webviews.
   * The token contains:
   * - User ID in the 'sub' claim
   * - Frontend token in the format 'userId:hash' where hash is created using the app's API key
   *
   * The frontend token can be verified by the App using their API key to ensure authenticity.
   *
   * @param aosUserId - The AugmentOS user ID to include in the token
   * @param packageName - The package name of the App to generate the frontend token for
   * @returns Promise resolving to a signed JWT token string
   * @throws Error if private key is not configured or token generation fails
   */
  async issueUserToken(
    aosUserId: string,
    packageName: string,
  ): Promise<string> {
    // Algorithm used for signing - RS256 (RSA with SHA-256)
    const alg: string = "RS256";

    try {
      // Import the private key from the environment
      if (!APP_AUTH_JWT_PRIVATE_KEY) {
        throw new Error("[token.service] APP_AUTH_JWT_PRIVATE_KEY is not set");
      }

      // Import the PKCS8 private key for JWT signing
      const privateKey = await importPKCS8(APP_AUTH_JWT_PRIVATE_KEY, alg);

      // Generate a frontend token using the app's API key hash instead of a shared secret
      // This allows the App to verify the token using their own API key
      const frontendTokenHash: string = await appService.hashWithApiKey(
        aosUserId,
        packageName,
      );

      // Create and sign the JWT token with both user ID and frontend token
      const token: string = await new SignJWT({
        sub: aosUserId, // Subject: the user ID
        frontendToken: `${aosUserId}:${frontendTokenHash}`, // Format: userId:hash for verification
      })
        .setProtectedHeader({ alg, kid: "v1" }) // Key ID for potential key rotation
        .setIssuer("https://prod.augmentos.cloud") // Token issuer
        .setIssuedAt() // Current timestamp
        .setExpirationTime("10m") // 10 minute expiration
        .sign(privateKey);
      return token;
    } catch (error) {
      logger.error(
        { error, aosUserId, packageName },
        "[token.service] Failed to issue user token",
      );
      throw new Error("[token.service] Failed to generate signed user token");
    }
  }
}

export const tokenService = new TokenService();
