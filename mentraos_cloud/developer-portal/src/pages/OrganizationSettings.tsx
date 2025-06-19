import React, { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle2, AlertCircle, Loader2, Building, Globe, Mail, FileText, Image, AlertTriangle, LockIcon, Trash, Plus } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DashboardLayout from "../components/DashboardLayout";
import api from '@/services/api.service';
import { toast } from 'sonner';
import { useOrganization } from '@/context/OrganizationContext';
import { useOrgPermissions } from '@/hooks/useOrgPermissions';
import ImageUpload from '@/components/forms/ImageUpload';
import CreateOrgDialog from '@/components/dialogs/CreateOrgDialog';
import { useSearchParams } from 'react-router-dom';

/**
 * Organization settings page - allows editing the current organization's profile
 */
const OrganizationSettings: React.FC = () => {
  const { currentOrg, refreshOrgs, ensurePersonalOrg, loading: orgLoading, orgs, setCurrentOrg } = useOrganization();
  const { isAdmin, loading: permissionsLoading } = useOrgPermissions();
  const [searchParams] = useSearchParams();

  // Check for welcome parameters
  const isNewMember = searchParams.get('welcome') === 'true';
  const invitedOrgName = searchParams.get('orgName');
  const invitedOrgId = searchParams.get('orgId');
  const isExistingMember = searchParams.get('existing') === 'true';

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    profile: {
      website: '',
      contactEmail: '',
      description: '',
      logo: ''
    }
  });

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaved, setIsSaved] = useState(false);
  const [isCreatingOrg, setIsCreatingOrg] = useState(false);
  // Delete org state
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // State for create org dialog
  const [showCreateOrgDialog, setShowCreateOrgDialog] = useState(false);

  // Handle missing organization by creating a personal one
  useEffect(() => {
    const createPersonalOrg = async () => {
      if (!currentOrg && !orgLoading && !isCreatingOrg) {
        setIsCreatingOrg(true);
        try {
          await ensurePersonalOrg();
          toast.success('A personal organization has been created for you.');
        } catch (err) {
          console.error('Error creating personal organization:', err);
          toast.error('Failed to create a personal organization. Please try again.');
        } finally {
          setIsCreatingOrg(false);
        }
      }
    };

    createPersonalOrg();
  }, [currentOrg, orgLoading, ensurePersonalOrg, isCreatingOrg]);

  // Auto-switch to invited organization
  useEffect(() => {
    if (invitedOrgId && orgs.length > 0 && !orgLoading) {
      const invitedOrg = orgs.find(org => org.id === invitedOrgId);
      if (invitedOrg && (!currentOrg || currentOrg.id !== invitedOrgId)) {
        setCurrentOrg(invitedOrg);
      }
    }
  }, [invitedOrgId, orgs.length, orgLoading, currentOrg?.id, setCurrentOrg]);

  // Fetch organization data
  useEffect(() => {
    const fetchOrgData = async () => {
      if (!currentOrg) {
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        setError(null);

        // Get the latest organization data
        const org = await api.orgs.get(currentOrg.id);

        // Set form data
        setFormData({
          name: org.name || '',
          profile: {
            website: org.profile?.website || '',
            contactEmail: org.profile?.contactEmail || '',
            description: org.profile?.description || '',
            logo: org.profile?.logo || ''
          }
        });
      } catch (err) {
        console.error('Error fetching organization data:', err);
        setError('Failed to load organization data. Please try again.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchOrgData();
  }, [currentOrg?.id]); // Use stable ID instead of object reference

  // Handle form changes
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.currentTarget as any;

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

  // Validate form
  const validateForm = () => {
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
      setError('Please enter a valid contact email address');
      return false;
    }

    return true;
  };

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!currentOrg) {
      setError('No organization selected');
      return;
    }

    setError(null);
    setIsSaved(false);

    // Validate form
    if (!validateForm()) {
      return;
    }

    setIsSaving(true);

    try {
      // Update organization via API
      await api.orgs.update(currentOrg.id, formData);

      // Refresh organizations in context
      await refreshOrgs();

      // Show success message
      setIsSaved(true);
      toast.success('Organization updated successfully');

      // Reset saved status after 3 seconds
      setTimeout(() => {
        setIsSaved(false);
      }, 3000);
    } catch (err) {
      console.error('Error updating organization:', err);
      setError('Failed to update organization. Please try again.');
      toast.error('Failed to update organization');
    } finally {
      setIsSaving(false);
    }
  };

  // Handle organization deletion
  const handleDeleteOrg = async () => {
    if (!currentOrg) return;

    const confirmed = typeof globalThis !== 'undefined' && typeof (globalThis as any).confirm === 'function'
      ? (globalThis as any).confirm(
          `Are you sure you want to permanently delete the organization "${currentOrg.name}"? This action cannot be undone.`
        )
      : false;

    if (!confirmed) return;

    try {
      setIsDeleting(true);
      setDeleteError(null);

      await api.orgs.delete(currentOrg.id);

      toast.success('Organization deleted successfully');

      // Refresh organizations list; OrganizationContext will handle currentOrg selection
      await refreshOrgs();
    } catch (err: any) {
      console.error('Error deleting organization:', err);
      const message = err?.response?.data?.message || 'Failed to delete organization.';
      setDeleteError(message);
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  };

  // Handle organization selection change
  const handleOrgChange = (orgId: string) => {
    const selectedOrg = orgs.find(org => org.id === orgId);
    if (selectedOrg) {
      setCurrentOrg(selectedOrg);
      toast.success(`Switched to ${selectedOrg.name}`);
    }
  };

  // Handle successful organization creation
  const handleOrgCreated = async () => {
    await refreshOrgs();

    // Get the updated list and find the most recently created org (it should be the last one)
    const updatedOrgs = await api.orgs.list();
    if (updatedOrgs.length > 0) {
      const newestOrg = updatedOrgs[updatedOrgs.length - 1];
      setCurrentOrg(newestOrg);
      toast.success(`Organization "${newestOrg.name}" created and selected`);
    }
  };

  // If no organization selected but we're creating one, show loading state
  if (!currentOrg) {
    return (
      <DashboardLayout>
        <div className="max-w-3xl mx-auto">
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="text-2xl">Organization Settings</CardTitle>
              <CardDescription>
                {isCreatingOrg
                  ? 'Creating a personal organization for you...'
                  : 'No organization selected'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isCreatingOrg ? (
                <div className="flex flex-col items-center justify-center p-6">
                  <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
                  <p className="text-muted-foreground">Creating your personal organization...</p>
                </div>
              ) : (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    You don't have an active organization. Please wait while we create one for you.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto">
        {/* Welcome message for new members */}
        {(isNewMember || isExistingMember) && (
          <Card className="shadow-sm mb-6 border-green-200 bg-green-50">
            <CardHeader className="pb-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="h-8 w-8 text-green-600 mt-1" />
                <div className="flex-1">
                  <CardTitle className="text-2xl text-green-900">
                    {isNewMember
                      ? `Welcome to ${invitedOrgName || currentOrg?.name || 'the organization'}!`
                      : 'Welcome back!'}
                  </CardTitle>
                  <CardDescription className="text-green-700 mt-2">
                    {isNewMember
                      ? `You have successfully joined ${invitedOrgName || currentOrg?.name || 'the organization'}. You can now collaborate with your team members and manage apps together.`
                      : `You're already a member of this organization. You can access all your organization's resources and collaborate with your team.`}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex flex-col gap-2 text-sm text-green-700">
                <p className="font-medium">What you can do now:</p>
                <ul className="list-disc list-inside space-y-1 ml-2">
                  {isAdmin && (
                    <li>View and manage organization settings on this page</li>
                  )}
                  <li>
                    Access the organization's{' '}
                    <a
                      href="/tpas"
                      className="font-medium underline hover:text-green-800"
                    >
                      apps and resources
                    </a>
                  </li>
                  <li>Collaborate with other team members</li>
                  <li>Create and publish apps under this organization</li>
                </ul>
                <div className="mt-3 p-3 bg-green-100 rounded-md">
                  <p className="text-sm text-green-800">
                    💡 <strong>Tip:</strong> You can switch between different organizations you're a member of using the dropdown in the upper left corner of the dashboard.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Organization Selector Section */}
        <Card className="shadow-sm mb-6">
          <CardHeader>
            <CardTitle className="text-xl">Current Organization</CardTitle>
            <CardDescription>
              Select which organization you want to manage. You can switch between organizations you're a member of or create a new one.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <Label htmlFor="org-selector" className="sr-only">
                  Select Organization
                </Label>
                <Select
                  value={currentOrg?.id}
                  onValueChange={handleOrgChange}
                  disabled={orgLoading}
                >
                  <SelectTrigger id="org-selector" className="w-full">
                    <SelectValue placeholder={orgLoading ? "Loading..." : "Select an organization"} />
                  </SelectTrigger>
                  <SelectContent>
                    {orgs.length === 0 ? (
                      <SelectItem value="no-orgs" disabled>
                        No organizations available
                      </SelectItem>
                    ) : (
                      orgs.map(org => (
                        <SelectItem key={org.id} value={org.id}>
                          {org.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={() => setShowCreateOrgDialog(true)}
                className="gap-2"
              >
                <Plus className="h-4 w-4" />
                New Organization
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Main Settings Card */}
        <Card className="shadow-sm">
          {isLoading || permissionsLoading ? (
            <div className="p-8 text-center">
              <div className="animate-spin mx-auto h-8 w-8 border-t-2 border-b-2 border-blue-500 rounded-full"></div>
              <p className="mt-2 text-gray-500">Loading organization data...</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <CardHeader>
                <CardTitle className="text-2xl">Organization Settings</CardTitle>
                <CardDescription>
                  {isAdmin
                    ? "Update your organization information which will be displayed on your app's page in the App Store."
                    : "View organization information (read-only). Only administrators can update these settings."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                {isSaved && (
                  <Alert className="bg-green-50 text-green-800 border-green-200">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <AlertDescription className="text-green-700">Organization updated successfully!</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2 mt-4">
                  <Label htmlFor="name" className="flex items-center gap-2">
                    <Building className="h-4 w-4" />
                    Organization Name <span className="text-red-500 ml-1">*</span>
                  </Label>
                  <Input
                    id="name"
                    name="name"
                    value={formData.name}
                    onChange={handleChange}
                    placeholder="Your organization name"
                    required
                    readOnly={!isAdmin}
                    className={!isAdmin ? "bg-gray-50 text-gray-500" : ""}
                  />
                  <p className="text-xs text-gray-500">
                    The name of your organization that will be displayed to users. Required to publish apps.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="website" className="flex items-center gap-2">
                    <Globe className="h-4 w-4" />
                    Website
                  </Label>
                  <Input
                    id="website"
                    name="website"
                    value={formData.profile.website}
                    onChange={handleChange}
                    placeholder="https://example.com"
                    readOnly={!isAdmin}
                    className={!isAdmin ? "bg-gray-50 text-gray-500" : ""}
                  />
                  <p className="text-xs text-gray-500">
                    Your organization's website URL.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="contactEmail" className="flex items-center gap-2">
                    <Mail className="h-4 w-4" />
                    Contact Email <span className="text-red-500 ml-1">*</span>
                  </Label>
                  <Input
                    id="contactEmail"
                    name="contactEmail"
                    value={formData.profile.contactEmail}
                    onChange={handleChange}
                    placeholder="support@example.com"
                    required
                    type="email"
                    readOnly={!isAdmin}
                    className={!isAdmin ? "bg-gray-50 text-gray-500" : ""}
                  />
                  <p className="text-xs text-gray-500">
                    An email address where users can contact you for support or inquiries. Required to publish apps.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description" className="flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    Organization Description
                  </Label>
                  <Textarea
                    id="description"
                    name="description"
                    value={formData.profile.description}
                    onChange={handleChange}
                    placeholder="Tell users about your organization"
                    rows={4}
                    readOnly={!isAdmin}
                    className={!isAdmin ? "bg-gray-50 text-gray-500" : ""}
                  />
                  <p className="text-xs text-gray-500">
                    A short description of your organization.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="logo" className="flex items-center gap-2">
                    <Image className="h-4 w-4" />
                    Logo URL
                  </Label>
                  <ImageUpload
                    currentImageUrl={formData.profile.logo}
                    onImageUploaded={(url) => {
                      setFormData(prev => ({
                        ...prev,
                        profile: {
                          ...prev.profile,
                          logo: url
                        }
                      }));
                    }}
                    packageName={`org-${currentOrg?.id}`} // Use org ID as identifier for metadata
                    disabled={!isAdmin || isSaving}
                  />
                  {/* Note: The actual Cloudflare URL is stored in logo but not displayed to the user */}
                  <p className="text-xs text-gray-500">
                    {isAdmin
                      ? "Upload your organization logo (recommended: square format, 512x512 PNG)."
                      : "Organization logo"}
                  </p>
                </div>

                {/* Delete organization section (admins only) */}
                {deleteError && (
                      <Alert variant="destructive" className="mb-4">
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription>{deleteError}</AlertDescription>
                      </Alert>
                    )}
              </CardContent>
              <CardFooter className="flex justify-end p-6">
                                  {isAdmin ? (
                                    <div className="flex gap-4">
                                      <Button
                                        type="button"
                                        variant="destructive"
                                        onClick={handleDeleteOrg}
                                        disabled={isDeleting}
                                        className="gap-2"
                                      >
                                        {isDeleting ? (
                                          <>
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            Deleting...
                                          </>
                                        ) : (
                                          <>
                                            <Trash className="h-4 w-4" />
                                            Delete Organization
                                          </>
                                        )}
                                      </Button>
                                      <Button type="submit" disabled={isSaving}>
                                        {isSaving ? (
                                          <>
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                            Saving...
                                          </>
                                        ) : (
                                          'Save Changes'
                                        )}
                                      </Button>
                                    </div>
                                  ) : (
                  <p className="text-sm text-muted-foreground">
                    Contact an administrator to make changes
                  </p>
                )}
              </CardFooter>
            </form>
          )}
        </Card>

        {/* Create Organization Dialog */}
        <CreateOrgDialog
          open={showCreateOrgDialog}
          onOpenChange={setShowCreateOrgDialog}
          onOrgCreated={handleOrgCreated}
        />
      </div>
    </DashboardLayout>
  );
};

export default OrganizationSettings;