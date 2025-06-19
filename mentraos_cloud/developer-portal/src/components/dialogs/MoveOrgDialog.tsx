import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AlertCircle, Loader2, MoveIcon } from "lucide-react";
import { Organization } from '@/services/api.service';
import { TPA } from '@/types/tpa';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';

/**
 * Interface for MoveOrgDialog props
 */
interface MoveOrgDialogProps {
  /**
   * Whether the dialog is open
   */
  open: boolean;

  /**
   * Function to set whether the dialog is open
   */
  onOpenChange: (open: boolean) => void;

  /**
   * The TPA to move
   */
  tpa: TPA;

  /**
   * List of organizations the user is a member of with admin rights
   */
  eligibleOrgs: Organization[];

  /**
   * ID of the current organization
   */
  currentOrgId: string;

  /**
   * Function to call when the TPA is successfully moved
   */
  onMoveComplete: () => void;

  /**
   * Function to move the TPA to a different organization
   */
  onMove: (targetOrgId: string) => Promise<void>;
}

/**
 * Dialog for moving a TPA to a different organization
 */
const MoveOrgDialog: React.FC<MoveOrgDialogProps> = ({
  open,
  onOpenChange,
  tpa,
  eligibleOrgs,
  currentOrgId,
  onMoveComplete,
  onMove
}) => {
  // State for the selected target organization
  const [selectedOrgId, setSelectedOrgId] = useState<string>('');

  // Loading and error states
  const [isMoving, setIsMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter out the current organization from the eligible orgs
  const targetOrgs = eligibleOrgs.filter(org => org.id !== currentOrgId);

  // Get the name of the current organization
  const currentOrgName = eligibleOrgs.find(org => org.id === currentOrgId)?.name || 'Current Organization';

  /**
   * Handle the move operation
   */
  const handleMove = async () => {
    if (!selectedOrgId) {
      setError('Please select a target organization');
      return;
    }

    try {
      setError(null);
      setIsMoving(true);

      // Call the onMove function provided by the parent component
      await onMove(selectedOrgId);

      // Close the dialog and reset state
      onOpenChange(false);
      setSelectedOrgId('');

      // Notify parent component
      onMoveComplete();
    } catch (err) {
      console.error('Error moving TPA:', err);
      setError(err instanceof Error ? err.message : 'Failed to move app to the selected organization');
    } finally {
      setIsMoving(false);
    }
  };

  /**
   * Reset state when dialog closes
   */
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setSelectedOrgId('');
      setError(null);
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center">
            <MoveIcon className="h-5 w-5 mr-2" />
            Move App to Another Organization
          </DialogTitle>
          <DialogDescription>
            Move "{tpa.name}" from {currentOrgName} to another organization where you have admin access.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="targetOrg">Target Organization</Label>
            <Select
              value={selectedOrgId}
              onValueChange={setSelectedOrgId}
              disabled={isMoving || targetOrgs.length === 0}
            >
              <SelectTrigger id="targetOrg">
                <SelectValue placeholder="Select organization" />
              </SelectTrigger>
              <SelectContent>
                {targetOrgs.length === 0 ? (
                  <SelectItem value="none" disabled>
                    No eligible organizations found
                  </SelectItem>
                ) : (
                  targetOrgs.map(org => (
                    <SelectItem key={org.id} value={org.id}>
                      {org.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="text-sm text-amber-700 bg-amber-50 p-4 rounded-md">
            <p className="font-medium mb-2">Warning:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>This action will move the app and all its settings to the selected organization.</li>
              <li>Members of the target organization will gain access to this app.</li>
              <li>Current organization members will lose access (unless they're also in the target organization).</li>
              <li>This action cannot be automatically reversed.</li>
            </ul>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isMoving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleMove}
            disabled={!selectedOrgId || isMoving || targetOrgs.length === 0}
            variant="destructive"
          >
            {isMoving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Moving...
              </>
            ) : "Confirm Move"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default MoveOrgDialog;