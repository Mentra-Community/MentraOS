import jwt from 'jsonwebtoken';
import { tokenService } from './temp-token.service';
import { logger } from '@augmentos/utils';

export const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || "";
export const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

export class AuthService {
  async exchangeSupabaseToken(supabaseToken: string): Promise<{ coreToken: string } | { error: string }> {
    try {
      const decoded = jwt.verify(supabaseToken, SUPABASE_JWT_SECRET);
      const subject = decoded.sub;

      const newData = {
        sub: subject,
        email: (decoded as jwt.JwtPayload).email,
      };

      const coreToken = jwt.sign(newData, AUGMENTOS_AUTH_JWT_SECRET);
      return { coreToken };
    } catch (error) {
      logger.error('Token verification error:', error);
      return { error: 'Invalid token' };
    }
  }

  async generateWebviewToken(userId: string, packageName: string): Promise<{ success: boolean, token?: string, error?: string }> {
    if (!packageName) {
      return { success: false, error: 'packageName is required' };
    }

    try {
      const tempToken = await tokenService.generateTemporaryToken(userId, packageName);
      return { success: true, token: tempToken };
    } catch (error) {
      logger.error(`Error generating webview token for user ${userId}, package ${packageName}:`, error);
      return { success: false, error: 'Failed to generate token' };
    }
  }

  async exchangeUserToken(tempToken: string, packageName: string): Promise<{ success: boolean, userId?: string, error?: string }> {
    if (!tempToken) {
      return { success: false, error: 'Missing temporary token' };
    }

    try {
      const result = await tokenService.exchangeTemporaryToken(tempToken, packageName);

      if (result) {
        return { success: true, userId: result.userId };
      } else {
        return { success: false, error: 'Invalid or expired token' };
      }
    } catch (error) {
      logger.error(`Error exchanging webview token ${tempToken} for ${packageName}:`, error);
      return { success: false, error: 'Failed to exchange token' };
    }
  }
}

export const authService = new AuthService();
