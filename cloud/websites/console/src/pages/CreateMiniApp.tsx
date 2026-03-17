// pages/CreateMiniApp.tsx
import { useState } from "react";
import { AxiosError } from "axios";
import { Alert, AlertDescription, Button, Input, Label, Textarea } from "@mentra/shared";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeftIcon, AlertCircle, CheckCircle } from "lucide-react";
import DashboardLayout from "../components/DashboardLayout";
import ApiKeyDialog from "../components/dialogs/ApiKeyDialog";
import AppSuccessDialog from "../components/dialogs/AppSuccessDialog";
import api, { AppResponse } from "@/services/api.service";

import { normalizeUrl } from "@/libs/utils";
import { PermissionsSection } from "../components/forms/PermissionsSection";
import { HardwareRequirementsSection } from "../components/forms/HardwareRequirementsSection";
import { AppTypeSelect } from "../components/forms/AppTypeSelect";
import { ServerUrlField } from "../components/forms/ServerUrlField";
import { Permission, PermissionType } from "@/types/app";
import { AppI, HardwareRequirement } from "@mentra/sdk";
import { useOrgStore } from "@/stores/orgs.store";
import { App } from "@/types/app";
import ImageUpload from "../components/forms/ImageUpload";
import { WebviewUrlToggle } from "../components/forms/WebviewUrlToggle";
import { FormSection } from "../components/ui/FormSection";
// import { useAppStore } from "@/stores/apps.store";

enum AppType {
  STANDARD = "standard",
  BACKGROUND = "background",
}
/**
 * Page for creating a new MiniApp
 */
const CreateMiniApp: React.FC = () => {
  const navigate = useNavigate();
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const orgs = useOrgStore((s) => s.orgs);
  const currentOrg = orgs.find((o) => o.id === selectedOrgId) || null;
  // const createAppAction = useAppStore((s) => s.createApp);

  // Form state
  const [formData, setFormData] = useState<Partial<App>>({
    packageName: "",
    name: "",
    description: "",
    publicUrl: "",
    logoURL: "",
    webviewURL: "",
    appType: AppType.BACKGROUND, // Default to BACKGROUND
    permissions: [
      {
        type: PermissionType.MICROPHONE,
        description:
          "Access to microphone for voice input and audio processing",
      },
    ], // Default opt-in Microphone permission; user can remove if not needed
    hardwareRequirements: [], // Initialize hardware requirements as empty array
    // isPublic: false,
  });

  // Validation state
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Dialog states
  const [createdApp, setCreatedApp] = useState<AppResponse | null>(null);
  const [apiKey, setApiKey] = useState<string>("");
  const [isApiKeyDialogOpen, setIsApiKeyDialogOpen] = useState(false);
  const [isSuccessDialogOpen, setIsSuccessDialogOpen] = useState(false);

  // Helper to get org domain from user email
  // const orgDomain = user?.email?.split('@')[1] || '';
  // Check if orgDomain is a public email provider
  // const isPublicEmailDomain = publicEmailDomains.includes(orgDomain);

  // Handle form changes
  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const { name, value } = e.currentTarget;
    setFormData((prev: Partial<App>) => ({
      ...prev,
      [name]: value,
    }));

    // Clear error for field when changed
    if (errors[name]) {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[name];
        return newErrors;
      });
    }
  };

  // Handle URL field blur event to normalize URLs
  const handleUrlBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const { name, value } = e.currentTarget;

    // Only normalize URL fields
    if (name === "publicUrl" || name === "logoURL" || name === "webviewURL") {
      if (value) {
        try {
          // Normalize the URL and update the form field
          const normalizedUrl = normalizeUrl(value);
          setFormData((prev) => ({
            ...prev,
            [name]: normalizedUrl,
          }));

          // Clear any URL validation errors
          if (errors[name]) {
            setErrors((prev) => {
              const newErrors = { ...prev };
              delete newErrors[name];
              return newErrors;
            });
          }
        } catch (error) {
          console.error(`Error normalizing ${name}:`, error);
        }
      }
    }
  };

  // Handle permissions changes
  const handlePermissionsChange = (permissions: Permission[]) => {
    setFormData((prev) => ({
      ...prev,
      permissions,
    }));
  };

  // Handle hardware requirements changes
  const handleHardwareRequirementsChange = (
    hardwareRequirements: HardwareRequirement[],
  ) => {
    setFormData((prev) => ({
      ...prev,
      hardwareRequirements,
    }));
  };

  // Handle AppType changes
  const handleAppTypeChange = (value: string) => {
    setFormData((prev) => ({
      ...prev,
      appType: value as AppType,
    }));
  };

  // Validate form
  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    // Package name validation
    if (!formData.packageName) {
      newErrors.packageName = "Package name is required";
    } else if (!/^[a-z0-9.-]+$/.test(formData.packageName)) {
      newErrors.packageName =
        "Package name must use lowercase letters, numbers, dots, and hyphens only";
    }

    // Display name validation
    if (!formData.name) {
      newErrors.name = "Display name is required";
    }

    // Description validation
    if (!formData.description) {
      newErrors.description = "Description is required";
    }

    // Public URL validation
    if (!formData.publicUrl) {
      newErrors.publicUrl = "Server URL is required";
    } else {
      try {
        // Apply normalizeUrl to handle missing protocols before validation
        const normalizedUrl = normalizeUrl(formData.publicUrl);
        new URL(normalizedUrl);

        // Update the form data with the normalized URL
        setFormData((prev) => ({
          ...prev,
          publicUrl: normalizedUrl,
        }));
      } catch (e) {
        console.error(e);
        newErrors.publicUrl = "Please enter a valid URL";
      }
    }

    // Logo URL validation
    if (!formData.logoURL) {
      newErrors.logoURL = "Logo is required";
    }

    // Webview URL validation (optional)
    if (formData.webviewURL) {
      try {
        // Apply normalizeUrl to handle missing protocols before validation
        const normalizedUrl = normalizeUrl(formData.webviewURL);
        new URL(normalizedUrl);

        // Update the form data with the normalized URL
        setFormData((prev) => ({
          ...prev,
          webviewURL: normalizedUrl,
        }));
      } catch (e) {
        console.error(e);
        newErrors.webviewURL = "Please enter a valid URL";
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Clear previous error/success messages
    setFormError(null);
    setSuccessMessage(null);

    // Validate form data
    if (!validateForm()) {
      // Scroll to top to show errors
      window.scrollTo(0, 0);
      return;
    }

    // Check if organization is selected
    if (!currentOrg) {
      setFormError("Please select an organization to create this app");
      window.scrollTo(0, 0);
      return;
    }

    // Start loading state
    setIsLoading(true);

    try {
      // Prepare App data
      // If webviewURL is empty, use the default based on publicUrl
      let finalWebviewUrl = formData.webviewURL;
      if (!finalWebviewUrl && formData.publicUrl) {
        try {
          const normalizedServerUrl = normalizeUrl(formData.publicUrl);
          const base = normalizedServerUrl.replace(/\/$/, "");
          finalWebviewUrl = `${base}/webview`;
        } catch {
          // If normalization fails, leave empty
          finalWebviewUrl = "";
        }
      }

      const appData: Partial<App> = {
        packageName: formData.packageName,
        name: formData.name,
        description: formData.description,
        publicUrl: formData.publicUrl,
        logoURL: formData.logoURL,
        webviewURL: finalWebviewUrl,
        appType: formData.appType,
        permissions: formData.permissions,
        hardwareRequirements: formData.hardwareRequirements,
      };

      // Create App via API
      const result = await api.apps.create(currentOrg.id, appData as AppI);

      // Store API key and created App details
      setApiKey(result.apiKey);
      setCreatedApp(result.app);

      // Show success message
      setSuccessMessage(`App "${formData.name}" created successfully!`);

      // Show API key dialog
      setIsApiKeyDialogOpen(true);
    } catch (error) {
      console.error("Error creating App:", error);

      // Handle specific error types
      if (error instanceof AxiosError && error.response) {
        // API error with response data
        if (error.response.status === 409) {
          // Package name conflict
          setErrors({
            ...errors,
            packageName:
              "This package name is already in use. Please choose another.",
          });
          setFormError("Package name is already in use");
        } else if (error.response.data?.error) {
          // Other API error with message
          setFormError(error.response.data.error);
        } else {
          // General API error
          setFormError("Failed to create app. Please try again.");
        }
      } else {
        // Network or other error
        setFormError(
          "Network error. Please check your connection and try again.",
        );
      }

      // Scroll to top to show error
      window.scrollTo(0, 0);
    } finally {
      // End loading state
      setIsLoading(false);
    }
  };

  // Handle API key dialog close - redirect to edit page for the newly created app
  const handleApiKeyDialogClose = (open: boolean) => {
    console.log("API Key dialog state changing to:", open);
    setIsApiKeyDialogOpen(open);

    // If dialog is closing, navigate to the edit page for the newly created app
    if (!open && createdApp) {
      navigate(`/apps/${createdApp.packageName}/edit`);
    }
  };

  // Handle success dialog close
  const handleSuccessDialogClose = (open: boolean) => {
    setIsSuccessDialogOpen(open);
  };

  // Handle view API key button click
  const handleViewApiKey = () => {
    console.log("View API Key button clicked");
    setIsSuccessDialogOpen(false);
    // Open API key dialog immediately
    setIsApiKeyDialogOpen(true);
  };

  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center mb-6">
          <Link
            to="/apps"
            className="flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon className="mr-1 h-4 w-4" />
            Back to MiniApps
          </Link>
        </div>

        <div>
          <form onSubmit={handleSubmit}>
            <div className="mb-8">
              <h1 className="text-2xl font-semibold tracking-tight">Create New MiniApp</h1>
              <p className="text-muted-foreground mt-1">
                Fill out the form below to register your MiniApp for MentraOS.
              </p>
              {currentOrg && (
                <div className="mt-3 text-sm">
                  <span className="text-muted-foreground">
                    Creating in organization:{" "}
                  </span>
                  <span className="font-medium">{currentOrg.name}</span>
                </div>
              )}
            </div>
            <div className="space-y-8">
              {formError && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              )}

              {/* MiniApp Distribution Section */}
              <FormSection
                title="MiniApp Distribution"
                description="Core details for your MiniApp listing in the Mentra MiniApp Store"
                helpLink={{ text: "Publishing Guide", href: "https://docs.mentraglass.com/app-devs/getting-started/overview" }}
              >
                <div className="space-y-2">
                  <Label htmlFor="packageName">
                    Package Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="packageName"
                    name="packageName"
                    value={formData.packageName}
                    onChange={handleChange}
                    placeholder="e.g., org.example.myapp"
                    className={errors.packageName ? "border-destructive" : ""}
                  />
                  {errors.packageName && (
                    <p className="text-xs text-destructive mt-1">
                      {errors.packageName}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Must use lowercase letters, numbers, dots, and hyphens only.
                    This is a unique identifier and cannot be changed later.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="name">
                    Display Name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="name"
                    name="name"
                    value={formData.name}
                    onChange={handleChange}
                    placeholder="e.g., My Awesome MiniApp"
                    className={errors.name ? "border-destructive" : ""}
                  />
                  {errors.name && (
                    <p className="text-xs text-destructive mt-1">{errors.name}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    The name that will be displayed to users in the Mentra MiniApp
                    Store.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">
                    Description <span className="text-destructive">*</span>
                  </Label>
                  <Textarea
                    id="description"
                    name="description"
                    value={formData.description}
                    onChange={handleChange}
                    placeholder="Describe what your app does..."
                    rows={3}
                    className={errors.description ? "border-destructive" : ""}
                  />
                  {errors.description && (
                    <p className="text-xs text-destructive mt-1">
                      {errors.description}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Provide a clear, concise description of your
                    application&apos;s functionality.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="logoURL">
                    MiniApp Logo <span className="text-destructive">*</span>
                  </Label>
                  <ImageUpload
                    currentImageUrl={formData.logoURL}
                    onImageUploaded={(url) => {
                      setFormData((prev) => ({
                        ...prev,
                        logoURL: url,
                      }));
                      // Clear error when image is uploaded
                      if (errors.logoURL) {
                        setErrors((prev) => {
                          const newErrors = { ...prev };
                          delete newErrors.logoURL;
                          return newErrors;
                        });
                      }
                    }}
                    packageName={formData.packageName}
                    disabled={isLoading}
                    hasError={!!errors.logoURL}
                    errorMessage={errors.logoURL}
                  />
                  <p className="text-xs text-muted-foreground">
                    Upload an image that will be used as your MiniApp&apos;s icon
                    (recommended: 512x512 PNG).
                  </p>
                </div>
              </FormSection>

              {/* MiniApp Configuration Section */}
              <FormSection
                title="MiniApp Configuration"
                description="Configure how MentraOS connects to your MiniApp server"
                helpLink={{ text: "Server Setup Guide", href: "https://docs.mentraglass.com/app-devs/getting-started/deployment/overview" }}
              >
                <ServerUrlField
                  value={formData.publicUrl || ""}
                  onChange={handleChange}
                  onBlur={handleUrlBlur}
                  error={errors.publicUrl}
                  required
                />

                <WebviewUrlToggle
                  value={formData.webviewURL || ""}
                  serverUrl={formData.publicUrl || ""}
                  onChange={(value) => {
                    setFormData((prev) => ({
                      ...prev,
                      webviewURL: value,
                    }));
                    // Clear error when changed
                    if (errors.webviewURL) {
                      setErrors((prev) => {
                        const newErrors = { ...prev };
                        delete newErrors.webviewURL;
                        return newErrors;
                      });
                    }
                  }}
                  onBlur={handleUrlBlur}
                  hasError={!!errors.webviewURL}
                  errorMessage={errors.webviewURL}
                  disabled={isLoading}
                />

                <AppTypeSelect
                  value={formData.appType || "background"}
                  onChange={handleAppTypeChange}
                />

                {/* Permissions */}
                <PermissionsSection
                  permissions={formData.permissions || []}
                  onChange={handlePermissionsChange}
                />

                {/* Minimum Hardware Requirements */}
                <HardwareRequirementsSection
                  requirements={formData.hardwareRequirements || []}
                  onChange={handleHardwareRequirementsChange}
                />
              </FormSection>

            </div>
            <div className="flex justify-between mt-8 pt-6 border-t">
              <Button
                variant="outline"
                type="button"
                onClick={() => navigate("/apps")}
              >
                Back
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading ? "Creating..." : "Create MiniApp"}
              </Button>
            </div>
          </form>

          {successMessage && (
            <div className="mt-6">
              <Alert className="bg-success-light border-1 border-success text-success shadow-md">
                <CheckCircle className="h-5 w-5 text-success" />
                <div>
                  <AlertDescription className="text-success font-medium">
                    {successMessage}
                  </AlertDescription>
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setIsApiKeyDialogOpen(true)}
                      className="border-success text-success hover:bg-success-light"
                    >
                      View API Key
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => navigate("/apps")}
                      className="border-success text-success hover:bg-success-light"
                    >
                      Go to My MiniApps
                    </Button>
                  </div>
                </div>
              </Alert>
            </div>
          )}
        </div>
      </div>

      {/* API Key Dialog after successful creation */}
      {createdApp && (
        <>
          <AppSuccessDialog
            app={createdApp}
            apiKey={apiKey}
            open={isSuccessDialogOpen}
            onOpenChange={handleSuccessDialogClose}
            onViewApiKey={handleViewApiKey}
          />

          <ApiKeyDialog
            app={createdApp}
            apiKey={apiKey}
            open={isApiKeyDialogOpen}
            onOpenChange={handleApiKeyDialogClose}
            onKeyRegenerated={(newKey) => {
              setApiKey(newKey);
              console.log(`API key regenerated for ${createdApp?.name}`);
            }}
            orgId={currentOrg?.id}
          />
        </>
      )}
    </DashboardLayout>
  );
};

export default CreateMiniApp;
