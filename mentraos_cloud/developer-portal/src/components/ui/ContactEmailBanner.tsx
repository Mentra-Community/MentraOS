import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useOrganization } from '@/context/OrganizationContext';
import { Link } from 'react-router-dom';

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
    <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-6">
      <div className="flex items-start">
        <div className="flex-shrink-0">
          <AlertTriangle className="h-5 w-5 text-yellow-400" />
        </div>
        <div className="ml-3">
          <h3 className="text-sm font-medium text-yellow-800">
            Organization profile incomplete
          </h3>
          <div className="mt-2 text-sm text-yellow-700">
            <p>
              Your organization needs a contact email before you can publish apps.
              This email will be used for app store communications and user support.
            </p>
          </div>
          <div className="mt-3">
            <Link
              to="/org-settings"
              className="text-sm font-medium text-yellow-800 hover:text-yellow-700 underline"
            >
              Complete organization profile →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ContactEmailBanner;