import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AppResponse } from '@/services/api.service';
import api from '@/services/api.service';
import { toast } from 'sonner';
import { TPA } from '@/types/tpa';
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";
import { useNavigate } from 'react-router-dom';
import { useOrganization } from '@/context/OrganizationContext';

interface PublishDialogProps {
  tpa: TPA | AppResponse;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPublishComplete?: (updatedTpa: AppResponse) => void;
  orgId?: string;
}

const PublishDialog: React.FC<PublishDialogProps> = ({
  tpa,
  open,
  onOpenChange,
  onPublishComplete,
  orgId,
}) => {
  const [isPublishing, setIsPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isProfileIncomplete, setIsProfileIncomplete] = useState(false);
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();

  // Check if organization profile is complete on open
  useEffect(() => {
    if (open && currentOrg) {
      const hasContactEmail = currentOrg.profile?.contactEmail;
      const hasName = currentOrg.name;
      setIsProfileIncomplete(!hasContactEmail || !hasName);
    }
  }, [open, currentOrg]);

  const goToProfile = () => {
    onOpenChange(false);
    navigate('/org-settings');
  };

  const handlePublish = async () => {
    try {
      // Do an additional check to ensure org profile is complete
      if (!currentOrg?.profile?.contactEmail) {
        setIsProfileIncomplete(true);
        setError('Your organization profile is incomplete. Please fill out your organization name and contact email before publishing an app.');
        return;
      }

      setIsPublishing(true);
      setError(null);

      // Use the provided orgId if available, otherwise fall back to currentOrg.id
      const effectiveOrgId = orgId || currentOrg?.id;
      const result = await api.apps.publish(tpa.packageName, effectiveOrgId);

      // Get the updated app data
      const updatedTpa = await api.apps.getByPackageName(tpa.packageName, effectiveOrgId);

      toast.success('App submitted for publication!');

      // Notify parent of the successful publish with updated data
      if (onPublishComplete) {
        onPublishComplete(updatedTpa);
      }

      onOpenChange(false);
    } catch (error: any) {
      console.error('Error publishing app:', error);

      // Check if this is a profile incomplete error
      if (error.response?.data?.error && error.response.data.error.includes('PROFILE_INCOMPLETE')) {
        setIsProfileIncomplete(true);
        setError('Your organization profile is incomplete. Please fill out your organization name and contact email before publishing an app.');
      } else {
        setError('Failed to publish app. Please try again.');
        toast.error('Failed to publish app');
      }
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Publish App to Store</DialogTitle>
          <DialogDescription>
            Are you ready to publish "{tpa.name}" to the AugmentOS App Store?
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {isProfileIncomplete ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                Before you can publish your app, you need to complete your organization profile. This information will be visible to users who install your app.
              </p>
              <Button onClick={goToProfile} className="w-full">
                Complete Organization Profile
              </Button>
            </div>
          ) : (
            <>
              <p className="text-sm text-gray-600 mb-3">
                Publishing your app will make it available for review. Once approved, it will be visible to all AugmentOS users.
              </p>
              <p className="text-sm text-gray-600">
                Your app will initially be submitted in a <strong>SUBMITTED</strong> state and will need to undergo review before being published.
              </p>
            </>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>

          {!isProfileIncomplete && (
            <Button
              onClick={handlePublish}
              disabled={isPublishing}
            >
              {isPublishing ? 'Publishing...' : 'Publish App'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PublishDialog;