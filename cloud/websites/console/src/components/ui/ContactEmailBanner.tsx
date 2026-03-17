import { AlertTriangle } from 'lucide-react';
import { useOrganization } from '@/context/OrganizationContext';
import { Link } from 'react-router-dom';
import { Alert, AlertTitle, AlertDescription } from '@mentra/shared';

/**
 * Banner component that displays a warning when the current organization
 * doesn't have a contact email set in its profile.
 *
 * @returns A warning banner or null if contact email exists
 */
export function ContactEmailBanner() {
  const { currentOrg } = useOrganization();

  // Don't show the banner if:
  // - No organization is selected
  // - The organization has a contact email
  if (!currentOrg || (currentOrg.profile && currentOrg.profile.contactEmail)) {
    return null;
  }

  return (
    <Alert variant="warning" className="mb-6">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Organization profile incomplete</AlertTitle>
      <AlertDescription>
        <p>
          Your organization needs a contact email before you can publish MiniApps.
          This email will be used for Mentra MiniApp Store communications and user support.
        </p>
        <Link
          to="/org-settings"
          className="mt-2 inline-block text-sm font-medium text-warning hover:text-warning/80 underline"
        >
          Complete organization profile →
        </Link>
      </AlertDescription>
    </Alert>
  );
}

export default ContactEmailBanner;
