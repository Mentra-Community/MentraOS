import jwt from 'jsonwebtoken';
import { emailService } from '../email/resend.service';
import { UserI } from '../../models/user.model';
import { Types } from 'mongoose';
import { Organization } from '../../models/organization.model';

const INVITE_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET;
if (!INVITE_JWT_SECRET) {
  throw new Error('INVITE_JWT_SECRET is not defined in environment variables');
}

/**
 * Interface for the payload of an invite token
 */
interface InviteTokenPayload {
  orgId: string;
  email: string;
  role: string;
  exp: number;
}

/**
 * Service for handling organization invitations
 */
export class InviteService {
  /**
   * Generates an invite token for a user to join an organization
   * @param orgId - ID of the organization
   * @param email - Email of the invitee
   * @param role - Role to assign to the invitee
   * @param inviter - User sending the invitation
   * @returns Promise with the invite token and result of email sending
   */
  static async generate(
    orgId: string | Types.ObjectId,
    email: string,
    role: string,
    inviter: UserI
  ): Promise<{ token: string; emailResult: { id?: string; error?: any } }> {
    // Convert orgId to string if it's an ObjectId
    const orgIdStr = orgId.toString();

    // Set expiration to 7 days (604800 seconds)
    const expiresAt = Math.floor(Date.now() / 1000) + 604800;

    // Create token payload
    const payload: InviteTokenPayload = {
      orgId: orgIdStr,
      email,
      role,
      exp: expiresAt
    };

    // Generate JWT token
    const token = jwt.sign(payload, INVITE_JWT_SECRET as string);

    // Get organization details for the email
    const organization = await Organization.findById(orgId);
    if (!organization) {
      throw new Error(`Organization with ID ${orgId} not found`);
    }

    // Send invitation email
    const emailResult = await emailService.sendOrganizationInvite(
      email,
      inviter.email,
      organization.name,
      token,
      role
    );

    return { token, emailResult };
  }

  /**
   * Verifies an invite token
   * @param token - JWT token to verify
   * @returns The decoded token payload if valid
   * @throws Error if token is invalid or expired
   */
  static verify(token: string): InviteTokenPayload {
    try {
      const decoded = jwt.verify(token, INVITE_JWT_SECRET as string) as InviteTokenPayload;
      return decoded;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error('Invitation link has expired. Please request a new invitation.');
      }
      throw new Error('Invalid invitation token. Please request a new invitation.');
    }
  }
}

export default InviteService;