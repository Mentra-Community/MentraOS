import { Resend } from 'resend';

/**
 * Email service using Resend API for sending transactional emails
 */
export class ResendEmailService {
  private resend: Resend;
  private defaultSender: string;

  /**
   * Initializes the Resend email service
   * @throws Error if RESEND_API_KEY is not defined in environment variables
   */
  constructor() {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY is not defined in environment variables');
    }
    this.resend = new Resend(apiKey);
    this.defaultSender = process.env.EMAIL_SENDER || 'AugmentOS <noreply@augmentos.org>';
  }

  /**
   * Sends an organization invitation email
   * @param recipientEmail - Email address of the invitee
   * @param inviterName - Name of the person sending the invitation
   * @param organizationName - Name of the organization
   * @param inviteToken - JWT token for accepting the invitation
   * @param role - Role assigned to the invitee
   * @returns Promise with the result of the email sending operation
   */
  async sendOrganizationInvite(
    recipientEmail: string,
    inviterName: string,
    organizationName: string,
    inviteToken: string,
    role: string
  ): Promise<{ id?: string; error?: any }> {
    const inviteUrl = `${process.env.DEV_CONSOLE_FRONTEND_URL || 'https://console.augmentos.org'}/invite/accept?token=${inviteToken}`;

    try {
      const { data, error } = await this.resend.emails.send({
        from: this.defaultSender,
        to: [recipientEmail],
        subject: `You've been invited to join ${organizationName} on AugmentOS`,
        html: this.generateInviteEmailHtml(inviterName, organizationName, inviteUrl, role),
      });

      if (error) {
        console.error('[resend.service] Failed to send invitation email:', error);
        return { error };
      }

      return { id: data?.id };
    } catch (error) {
      console.error('[resend.service] Error sending invitation email:', error);
      return { error };
    }
  }

  /**
   * Generates HTML content for organization invitation emails
   * @param inviterName - Name of the person sending the invitation
   * @param organizationName - Name of the organization
   * @param inviteUrl - URL for accepting the invitation
   * @param role - Role assigned to the invitee
   * @returns HTML string for the email
   * @private
   */
  private generateInviteEmailHtml(
    inviterName: string,
    organizationName: string,
    inviteUrl: string,
    role: string
  ): string {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Organization Invitation</title>
          <style>
            /* Base styles */
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              line-height: 1.6;
              color: #333;
              background-color: #f6f7f9;
              margin: 0;
              padding: 0;
            }

            /* Container */
            .container {
              max-width: 600px;
              margin: 0 auto;
              background-color: #ffffff;
              border-radius: 8px;
              border: 1px solid #e1e4e8;
              box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
              overflow: hidden;
            }

            /* Header */
            .header {
              background-color: #3a5fcd;
              color: white;
              text-align: center;
              padding: 30px 20px;
            }

            .header h1 {
              margin: 0;
              font-size: 28px;
              font-weight: 600;
              letter-spacing: 0.5px;
            }

            /* Content */
            .content {
              padding: 30px;
            }

            /* Typography */
            p {
              margin: 16px 0;
              font-size: 16px;
            }

            strong {
              font-weight: 600;
              color: #222;
            }

            /* Button */
            .button-container {
              text-align: center;
              margin: 35px 0;
            }

            .button {
              display: inline-block;
              background-color:rgb(206, 216, 248);
              color: #000;
              text-decoration: none;
              padding: 14px 32px;
              border-radius: 6px;
              font-weight: 600;
              font-size: 16px;
              letter-spacing: 0.3px;
              box-shadow: 0 4px 10px rgba(58, 95, 205, 0.3);
              transition: all 0.3s ease;
            }

            .button:hover {
              background-color:rgb(159, 177, 232));
            }

            /* Footer */
            .footer {
              background-color: #f6f7f9;
              padding: 20px;
              text-align: center;
              border-top: 1px solid #e1e4e8;
              margin-top: 20px;
              font-size: 13px;
              color: #666;
            }

            /* Utility */
            .highlight {
              color: #3a5fcd;
            }

            .note {
              font-size: 14px;
              color: #666;
              font-style: italic;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>You've Been Invited to an Organization on AugmentOS!</h1>
            </div>

            <div class="content">
              <p>Hello,</p>

              <p>
                <strong>${inviterName}</strong> has invited you to join
                <strong class="highlight">${organizationName}</strong>
                as a <strong>${role}</strong> on the AugmentOS Developer Console.
              </p>

              <p>As a member of this organization, you'll have access to all the applications and resources shared by the team.</p>

              <div class="button-container">
                <a href="${inviteUrl}" class="button">Accept Invitation</a>
              </div>

              <p class="note">This invitation link will expire in 7 days.</p>

              <p>If you didn't expect this invitation or have any questions, please contact ${inviterName}.</p>
            </div>

            <div class="footer">
              &copy; ${new Date().getFullYear()} Mentra Labs.
            </div>
          </div>
        </body>
      </html>
    `;
  }
}

// Create singleton instance
export const emailService = new ResendEmailService();
