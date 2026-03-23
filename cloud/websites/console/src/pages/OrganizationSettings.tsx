import React, { useState, useEffect, useRef } from "react";
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
} from "@mentra/shared";
import { CheckCircle2, AlertCircle, Loader2, Building, Globe, Mail, FileText, Image, Trash, Plus } from "lucide-react";
import DashboardLayout from "../components/DashboardLayout";
import api from "@/services/api.service";
import { toast } from "sonner";
import { useOrganization } from "@/context/OrganizationContext";
import { useOrgPermissions } from "@/hooks/useOrgPermissions";
import ImageUpload from "@/components/forms/ImageUpload";
import CreateOrgDialog from "@/components/dialogs/CreateOrgDialog";
import { useSearchParams } from "react-router-dom";

/**
 * Organization settings page - allows editing the current organization's profile
 */
const OrganizationSettings: React.FC = () => {
  const { currentOrg, refreshOrgs, ensurePersonalOrg, loading: orgLoading, orgs, setCurrentOrg } = useOrganization();
  const { isAdmin, loading: permissionsLoading } = useOrgPermissions();
  const [searchParams] = useSearchParams();

  // Check for welcome parameters
  const isNewMember = searchParams.get("welcome") === "true";
  const invitedOrgName = searchParams.get("orgName");
  const invitedOrgId = searchParams.get("orgId");
  const isExistingMember = searchParams.get("existing") === "true";

  // Form state
  const [formData, setFormData] = useState({
    name: "",
    profile: {
      website: "",
      contactEmail: "",
      description: "",
      logo: "",
    },
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
  // State for delete confirmation dialog
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Ref-based guard to ensure we only attempt personal org creation once per mount.
  // Previously, `ensurePersonalOrg` (not memoized) and `isCreatingOrg` were in the
  // dependency array, causing the effect to re-fire on every render. On failure,
  // `isCreatingOrg` flipped back to false while `currentOrg` was still null,
  // creating an infinite retry loop that produced the cycling toast messages
  // ("created" → "failed" → "created" → ...) that users reported.
  const orgCreationAttemptedRef = useRef(false);

  // Handle missing organization by creating a personal one (single attempt)
  useEffect(() => {
    if (currentOrg || orgLoading || orgCreationAttemptedRef.current) return;

    orgCreationAttemptedRef.current = true;
    setIsCreatingOrg(true);

    ensurePersonalOrg()
      .then(() => {
        toast.success("A personal organization has been created for you.");
      })
      .catch((err) => {
        console.error("Error creating personal organization:", err);
        toast.error("Failed to create a personal organization. Please try again.");
      })
      .finally(() => {
        setIsCreatingOrg(false);
      });
  }, [currentOrg, orgLoading]);
  // Note: ensurePersonalOrg is intentionally excluded — it is stable via useCallback
  // in the context, and including it previously caused infinite re-trigger loops.

  // Auto-switch to invited organization
  useEffect(() => {
    if (invitedOrgId && orgs.length > 0 && !orgLoading) {
      const invitedOrg = orgs.find((org) => org.id === invitedOrgId);
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
          name: org.name || "",
          profile: {
            website: org.profile?.website || "",
            contactEmail: org.profile?.contactEmail || "",
            description: org.profile?.description || "",
            logo: org.profile?.logo || "",
          },
        });
      } catch (err) {
        console.error("Error fetching organization data:", err);
        setError("Failed to load organization data. Please try again.");
      } finally {
        setIsLoading(false);
      }
    };

    fetchOrgData();
  }, [currentOrg?.id]); // Use stable ID instead of object reference

  // Handle form changes
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.currentTarget as any;

    if (name === "name") {
      setFormData((prev) => ({
        ...prev,
        name: value,
      }));
    } else {
      setFormData((prev) => ({
        ...prev,
        profile: {
          ...prev.profile,
          [name]: value,
        },
      }));
    }
  };

  // Validate form
  const validateForm = () => {
    if (!formData.name || formData.name.trim() === "") {
      setError("Organization name is required");
      return false;
    }

    if (!formData.profile.contactEmail || formData.profile.contactEmail.trim() === "") {
      setError("Contact email is required");
      return false;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(formData.profile.contactEmail)) {
      setError("Please enter a valid contact email address");
      return false;
    }

    return true;
  };

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!currentOrg) {
      setError("No organization selected");
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
      toast.success("Organization updated successfully");

      // Reset saved status after 3 seconds
      setTimeout(() => {
        setIsSaved(false);
      }, 3000);
    } catch (err) {
      console.error("Error updating organization:", err);
      setError("Failed to update organization. Please try again.");
      toast.error("Failed to update organization");
    } finally {
      setIsSaving(false);
    }
  };

  // Handle organization deletion
  const handleDeleteOrg = async () => {
    if (!currentOrg) return;

    try {
      setIsDeleting(true);
      setDeleteError(null);

      await api.orgs.delete(currentOrg.id);

      setShowDeleteDialog(false);
      toast.success("Organization deleted successfully");

      // Refresh organizations list; OrganizationContext will handle currentOrg selection
      await refreshOrgs();
    } catch (err: any) {
      console.error("Error deleting organization:", err);
      const message = err?.response?.data?.message || "Failed to delete organization.";
      setDeleteError(message);
      toast.error(message);
    } finally {
      setIsDeleting(false);
    }
  };

  // Handle organization selection change
  const handleOrgChange = (orgId: string) => {
    const selectedOrg = orgs.find((org) => org.id === orgId);
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
                {isCreatingOrg ? "Creating a personal organization for you..." : "No organization selected"}
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
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6 min-h-10">
          <h1 className="text-2xl font-semibold text-foreground">Organization Settings</h1>
        </div>

        <div className="space-y-6">
          {/* Welcome message for new members */}
          {(isNewMember || isExistingMember) && (
            <Card className="shadow-sm border-success bg-success-light">
              <CardHeader className="pb-4">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="h-8 w-8 text-success mt-1" />
                  <div className="flex-1">
                    <CardTitle className="text-2xl text-success">
                      {isNewMember
                        ? `Welcome to ${invitedOrgName || currentOrg?.name || "the organization"}!`
                        : "Welcome back!"}
                    </CardTitle>
                    <CardDescription className="text-success mt-2">
                      {isNewMember
                        ? `You have successfully joined ${invitedOrgName || currentOrg?.name || "the organization"}. You can now collaborate with your team members and manage apps together.`
                        : `You're already a member of this organization. You can access all your organization's resources and collaborate with your team.`}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex flex-col gap-2 text-sm text-success">
                  <p className="font-medium">What you can do now:</p>
                  <ul className="list-disc list-inside space-y-1 ml-2">
                    {isAdmin && <li>View and manage organization settings on this page</li>}
                    <li>
                      Access the organization's{" "}
                      <a href="/apps" className="font-medium underline hover:text-success">
                        apps and resources
                      </a>
                    </li>
                    <li>Collaborate with other team members</li>
                    <li>Create and publish apps under this organization</li>
                  </ul>
                  <div className="mt-3 p-3 bg-success-light rounded-md">
                    <p className="text-sm text-success">
                      💡 <strong>Tip:</strong> You can switch between different organizations you're a member of using
                      the dropdown in the upper left corner of the dashboard.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Organization Selector Section */}
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="text-xl">Current Organization</CardTitle>
              <CardDescription>
                Select which organization you want to manage. You can switch between organizations you're a member of or
                create a new one.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <Label htmlFor="org-selector" className="sr-only">
                    Select Organization
                  </Label>
                  <Select value={currentOrg?.id} onValueChange={handleOrgChange} disabled={orgLoading}>
                    <SelectTrigger id="org-selector" className="w-full">
                      <SelectValue placeholder={orgLoading ? "Loading..." : "Select an organization"} />
                    </SelectTrigger>
                    <SelectContent>
                      {orgs.length === 0 ? (
                        <SelectItem value="no-orgs" disabled>
                          No organizations available
                        </SelectItem>
                      ) : (
                        orgs.map((org) => (
                          <SelectItem key={org.id} value={org.id}>
                            {org.name}
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={() => setShowCreateOrgDialog(true)} className="gap-2">
                  <Plus className="h-4 w-4" />
                  New Organization
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Main Settings Card */}
          <Card className="shadow-sm">
            {isLoading || permissionsLoading ? (
              <div className="p-8 text-center flex flex-col items-center">
                <Spinner size="lg" />
                <p className="mt-2 text-muted-foreground">Loading organization data...</p>
              </div>
            ) : (
              <form onSubmit={handleSubmit}>
                <CardHeader>
                  <CardTitle className="text-2xl">Organization Settings</CardTitle>
                  <CardDescription>
                    {isAdmin
                      ? "Update your organization information which will be displayed on your MiniApp's page in the Mentra MiniApp Store."
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
                    <Alert className="bg-success-light text-success border-success">
                      <CheckCircle2 className="h-4 w-4 text-success" />
                      <AlertDescription className="text-success">Organization updated successfully!</AlertDescription>
                    </Alert>
                  )}

                  <div className="space-y-2 mt-4">
                    <Label htmlFor="name" className="flex items-center gap-2">
                      <Building className="h-4 w-4" />
                      Organization Name <span className="text-destructive ml-1">*</span>
                    </Label>
                    <Input
                      id="name"
                      name="name"
                      value={formData.name}
                      onChange={handleChange}
                      placeholder="Your organization name"
                      required
                      readOnly={!isAdmin}
                      className={!isAdmin ? "bg-secondary text-muted-foreground" : ""}
                    />
                    <p className="text-xs text-muted-foreground">
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
                      className={!isAdmin ? "bg-secondary text-muted-foreground" : ""}
                    />
                    <p className="text-xs text-muted-foreground">Your organization's website URL.</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="contactEmail" className="flex items-center gap-2">
                      <Mail className="h-4 w-4" />
                      Contact Email <span className="text-destructive ml-1">*</span>
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
                      className={!isAdmin ? "bg-secondary text-muted-foreground" : ""}
                    />
                    <p className="text-xs text-muted-foreground">
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
                      className={!isAdmin ? "bg-secondary text-muted-foreground" : ""}
                    />
                    <p className="text-xs text-muted-foreground">A short description of your organization.</p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="logo" className="flex items-center gap-2">
                      <Image className="h-4 w-4" />
                      Logo URL
                    </Label>
                    <ImageUpload
                      currentImageUrl={formData.profile.logo}
                      onImageUploaded={(url) => {
                        setFormData((prev) => ({
                          ...prev,
                          profile: {
                            ...prev.profile,
                            logo: url,
                          },
                        }));
                      }}
                      packageName={`org-${currentOrg?.id}`} // Use org ID as identifier for metadata
                      disabled={!isAdmin || isSaving}
                    />
                    {/* Note: The actual Cloudflare URL is stored in logo but not displayed to the user */}
                    <p className="text-xs text-muted-foreground">
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
                <CardFooter className="flex justify-between p-6">
                  {isAdmin ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setShowDeleteDialog(true)}
                        className="gap-2">
                        <Trash className="h-4 w-4" />
                        Delete Organization
                      </Button>
                      <Button type="submit" disabled={isSaving}>
                        {isSaving ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Saving...
                          </>
                        ) : (
                          "Save Changes"
                        )}
                      </Button>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">Contact an administrator to make changes</p>
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

          {/* Delete Organization Dialog */}
          <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete Organization</DialogTitle>
                <DialogDescription>
                  Are you sure you want to permanently delete "{currentOrg?.name}"? This action cannot be undone and all
                  associated data will be lost.
                </DialogDescription>
              </DialogHeader>
              {deleteError && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{deleteError}</AlertDescription>
                </Alert>
              )}
              <DialogFooter>
                <Button variant="secondary" onClick={() => setShowDeleteDialog(false)} disabled={isDeleting}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={handleDeleteOrg} disabled={isDeleting}>
                  {isDeleting ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    "Delete Organization"
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default OrganizationSettings;
