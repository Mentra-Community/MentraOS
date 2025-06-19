// components/dialogs/DeleteDialog.tsx
import React, { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Trash2, Loader2 } from "lucide-react";
// import { TPA } from "@/types/tpa";
import api from '@/services/api.service';
import { AppI } from '@augmentos/sdk';

interface DeleteDialogProps {
  tpa: AppI | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmDelete?: (packageName: string) => void; // Optional callback for parent component
  orgId?: string;
}

const DeleteDialog: React.FC<DeleteDialogProps> = ({
  tpa,
  open,
  onOpenChange,
  onConfirmDelete,
  orgId
}) => {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Handle delete confirmation
  const handleConfirmDelete = async () => {
    if (!tpa) return;

    setIsDeleting(true);
    setError(null);

    try {
      // Call API to delete the TPA
      await api.apps.delete(tpa.packageName, orgId);

      // Call the callback if provided (useful for updating UI)
      if (onConfirmDelete) {
        onConfirmDelete(tpa.packageName);
      }

      // Close dialog after deletion
      onOpenChange(false);
    } catch (err) {
      console.error("Error deleting TPA:", err);
      setError("Failed to delete TPA. Please try again.");
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-red-500" />
            Delete TPA
          </DialogTitle>
          <DialogDescription>
            {tpa && `Are you sure you want to delete ${tpa.name}?`}
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          <Alert variant="destructive" className="bg-red-50 border-red-200 text-red-800">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <AlertDescription className="text-red-700">
              This action cannot be undone. This will permanently delete the TPA
              and remove all associated data.
            </AlertDescription>
          </Alert>

          <div className="mt-4">
            <p className="text-sm text-gray-600">
              To confirm, you're deleting:
            </p>
            <p className="mt-2 font-medium">
              {tpa?.name} <span className="font-mono text-xs text-gray-500">({tpa?.packageName})</span>
            </p>
          </div>

          {error && (
            <Alert variant="destructive" className="mt-4">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isDeleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirmDelete}
            disabled={isDeleting}
          >
            {isDeleting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Deleting...
              </>
            ) : (
              'Delete TPA'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DeleteDialog;