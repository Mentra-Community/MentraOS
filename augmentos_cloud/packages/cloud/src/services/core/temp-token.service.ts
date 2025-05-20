// src/services/core/token.service.ts
import crypto from 'crypto';
import { TempToken, ITempToken } from '../../models/temp-token.model';
import { logger as rootLogger } from "../logging";
const logger = rootLogger.child({ service: 'temp-token.service' });

export class TokenService {
  /**
   * Generates a secure temporary token and stores it.
   * @param userId The user ID associated with the token.
   * @param packageName The package name of the TPA this token is intended for.
   * @returns The generated temporary token string.
   */
  async generateTemporaryToken(userId: string, packageName: string): Promise<string> {
    const logger = rootLogger.child({ service: 'temp-token.service', userId, packageName });
    const token = crypto.randomBytes(32).toString('hex');

    const tempTokenDoc = new TempToken({
      token,
      userId,
      packageName,
      createdAt: new Date(), // Explicitly set createdAt for clarity, though default works
      // Note: MongoDB TTL index handles expiration based on 'createdAt' field
    });

    try {
      await tempTokenDoc.save();
      logger.info(`Generated temporary token for user ${userId} and package ${packageName}`);
      return token;
    } catch (error) {
      logger.error(`Error saving temporary token for user ${userId}, package ${packageName}:`, error);
      throw new Error('Failed to generate temporary token');
    }
  }

  /**
   * Exchanges a temporary token for the associated user ID, validating the requesting TPA.
   * @param tempToken The temporary token string.
   * @param requestingPackageName The package name of the TPA making the exchange request.
   * @returns An object containing the userId if the token is valid and unused, otherwise null.
   */
  async exchangeTemporaryToken(tempToken: string, requestingPackageName: string): Promise<{ userId: string } | null> {
    const logger = rootLogger.child({ service: 'temp-token.service', requestingPackageName, tempToken });
    try {
      const tokenDoc = await TempToken.findOne({ token: tempToken });

      if (!tokenDoc) {
        logger.warn(`Temporary token not found: ${tempToken}`);
        return null; // Token doesn't exist
      }

      if (tokenDoc.used) {
        logger.warn(`Temporary token already used: ${tempToken}`);
        return null; // Token already used
      }

      // Check if the token has expired (TTL index should handle this, but double-check)
      const now = new Date();
      const createdAt = new Date(tokenDoc.createdAt);
      if (now.getTime() - createdAt.getTime() > 60000) { // 60 seconds TTL
        logger.warn(`Temporary token expired: ${tempToken}`);
        // Optionally delete the expired token here if TTL isn't reliable enough
        // await TempToken.deleteOne({ token: tempToken });
        return null;
      }

      // **Crucial Security Check:** Verify the requesting TPA matches the one the token was issued for.
      if (tokenDoc.packageName !== requestingPackageName) {
        logger.error(`Token mismatch: Token for ${tokenDoc.packageName} used by ${requestingPackageName}`);
        return null; // Token not intended for this application
      }

      // Mark the token as used to prevent replay attacks
      tokenDoc.used = true;
      await tokenDoc.save();

      logger.info(`Successfully exchanged temporary token for user ${tokenDoc.userId}, requested by ${requestingPackageName}`);
      return { userId: tokenDoc.userId };

    } catch (error) {
      logger.error(`Error exchanging temporary token ${tempToken}:`, { error, requestingPackageName, tempToken });
      return null; // Return null on any error during exchange
    }
  }
}

export const tokenService = new TokenService();