import React, { useState } from 'react';
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Loader2, Plus } from "lucide-react";
import api from '@/services/api.service';
import { toast } from 'sonner';

/**
 * Props for the CreateOrgDialog component
 */
interface CreateOrgDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Callback to change dialog open state */
  onOpenChange: (open: boolean) => void;
  /** Callback when organization is successfully created */
  onOrgCreated: () => void;
}

/**
 * Dialog component for creating a new organization
 *
 * @param props - Component props
 * @returns JSX element
 */
const CreateOrgDialog: React.FC<CreateOrgDialogProps> = ({
  open,
  onOpenChange,
  onOrgCreated
}) => {
  // Form state
  const [formData, setFormData] = useState({
    name: '',
    profile: {
      website: '',
      contactEmail: '',
      description: ''
    }
  });

  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Handle form field changes
   */
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;

    if (name === 'name') {
      setFormData(prev => ({
        ...prev,
        name: value
      }));
    } else {
      setFormData(prev => ({
        ...prev,
        profile: {
          ...prev.profile,
          [name]: value
        }
      }));
    }
  };

  /**
   * Validate form before submission
   */
  const validateForm = (): boolean => {
    if (!formData.name || formData.name.trim() === '') {
      setError('Organization name is required');
      return false;
    }

    if (!formData.profile.contactEmail || formData.profile.contactEmail.trim() === '') {
      setError('Contact email is required');
      return false;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(formData.profile.contactEmail)) {
      setError('Please enter a valid email address');
      return false;
    }

    return true;
  };

  /**
   * Handle form submission
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Clear previous errors
    setError(null);

    // Validate form
    if (!validateForm()) {
      return;
    }

    setIsCreating(true);

    try {
      // Create organization via API
      const newOrg = await api.orgs.create(formData.name);

      // Update organization with profile data
      const profileUpdate = {
        profile: {
          contactEmail: formData.profile.contactEmail,
          ...(formData.profile.website && { website: formData.profile.website }),
          ...(formData.profile.description && { description: formData.profile.description })
        }
      };

      await api.orgs.update(newOrg.id, profileUpdate);

      // Show success message
      toast.success(`Organization "${formData.name}" created successfully`);

      // Reset form
      setFormData({
        name: '',
        profile: {
          website: '',
          contactEmail: '',
          description: ''
        }
      });

      // Close dialog
      onOpenChange(false);

      // Notify parent component
      onOrgCreated();
    } catch (err: any) {
      console.error('Error creating organization:', err);
      const message = err?.response?.data?.message || 'Failed to create organization';
      setError(message);
      toast.error(message);
    } finally {
      setIsCreating(false);
    }
  };

  /**
   * Reset form when dialog closes
   */
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      // Reset form and errors when closing
      setFormData({
        name: '',
        profile: {
          website: '',
          contactEmail: '',
          description: ''
        }
      });
      setError(null);
    }
    onOpenChange(open);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" />
              Create New Organization
            </DialogTitle>
            <DialogDescription>
              Create a new organization to manage apps and collaborate with team members.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="name">
                Organization Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="name"
                name="name"
                value={formData.name}
                onChange={handleChange}
                placeholder="My Organization"
                required
                disabled={isCreating}
              />
              <p className="text-xs text-muted-foreground">
                This will be displayed as the developer name in the App Store.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="contactEmail">
                Contact Email <span className="text-red-500">*</span>
              </Label>
              <Input
                id="contactEmail"
                name="contactEmail"
                type="email"
                value={formData.profile.contactEmail}
                onChange={handleChange}
                placeholder="contact@example.com"
                required
                disabled={isCreating}
              />
              <p className="text-xs text-muted-foreground">
                Users will be able to contact you at this email for support.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="website">Website</Label>
              <Input
                id="website"
                name="website"
                value={formData.profile.website}
                onChange={handleChange}
                placeholder="https://example.com"
                disabled={isCreating}
              />
              <p className="text-xs text-muted-foreground">
                Your organization's website (optional).
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                name="description"
                value={formData.profile.description}
                onChange={handleChange}
                placeholder="Tell users about your organization..."
                rows={3}
                disabled={isCreating}
              />
              <p className="text-xs text-muted-foreground">
                A brief description of your organization (optional).
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isCreating}
            >
              {isCreating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Organization'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default CreateOrgDialog;