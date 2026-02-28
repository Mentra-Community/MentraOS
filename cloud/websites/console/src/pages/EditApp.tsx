// pages/EditApp.tsx
import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeftIcon,
  CheckCircle2,
  AlertCircle,
  Loader2,
  KeyRound,
  RefreshCw,
  LinkIcon,
  Upload,
  MoveIcon,
  Download,
  Files,
} from "lucide-react";
import DashboardLayout from "../components/DashboardLayout";
import { useAppStore } from "@/stores/apps.store";
import { useOrgStore } from "@/stores/orgs.store";
import { App, Permission, Setting, Tool } from "@/types/app";
import { HardwareRequirement, PreviewImage, PhotoOrientation } from "@mentra/sdk";
import { toast } from "sonner";
import ApiKeyDialog from "../components/dialogs/ApiKeyDialog";
import SharingDialog from "../components/dialogs/SharingDialog";
import PublishDialog from "../components/dialogs/PublishDialog";
import ImportConfigDialog from "../components/dialogs/ImportConfigDialog";
import { normalizeUrl } from "@/libs/utils";
import PermissionsForm from "../components/forms/PermissionsForm";
import SettingsEditor from "../components/forms/SettingsEditor";
import ToolsEditor from "../components/forms/ToolsEditor";
import HardwareRequirementsForm from "../components/forms/HardwareRequirementsForm";

// import publicEmailDomains from 'email-providers/all.json';
import MoveOrgDialog from "../components/dialogs/MoveOrgDialog";
import ImageUpload from "../components/forms/ImageUpload";
import AppTypeTooltip from "../components/forms/AppTypeTooltip";
import api, { Organization } from "@/services/api.service";
import { useAccountStore } from "@/stores/account.store";
import { MultiPhotoUpload, PhotoUploadItem } from "@/components/ui/multi-photo-upload";
// import { AppType } from '@mentra/sdk';

enum AppType {
  STANDARD = "standard",
  BACKGROUND = "background",
}
// Extend App type locally to include sharedWithOrganization
interface EditableApp extends App {
  sharedWithOrganization?: boolean;
}

interface ImportConfigData {
  name?: string;
  description?: string;
  onboardingInstructions?: string;
  publicUrl?: string;
  logoURL?: string;
  webviewURL?: string;
  appType?: AppType;
  permissions?: Permission[];
  settings?: Setting[];
  tools?: Tool[];
  version?: string;
  previewImages?: Array<{
    url: string;
    orientation: "landscape" | "portrait";
    order: number;
  }>;
}

export default function EditApp() {
  const navigate = useNavigate();
  const { packageName } = useParams<{ packageName: string }>();
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const orgs = useOrgStore((s) => s.orgs);
  const getApp = useAppStore((s) => s.getApp);
  const updateApp = useAppStore((s) => s.updateApp);

  const regenerateApiKeyStore = useAppStore((s) => s.regenerateApiKey);
  const moveAppStore = useAppStore((s) => s.moveApp);

  const accountEmail = useAccountStore((s) => s.email);
  const currentOrg = orgs.find((o) => o.id === selectedOrgId);

  // Form state
  const [formData, setFormData] = useState<EditableApp>({
    packageName: "",
    name: "",
    description: "",
    onboardingInstructions: "",
    publicUrl: "",
    logoURL: "",
    isPublic: false,
    appStoreStatus: "DEVELOPMENT",
    appType: "standard" as AppType, // Default value for AppType with cast
    createdAt: new Date().toISOString(), // Default value for AppResponse compatibility
    updatedAt: new Date().toISOString(), // Default value for AppResponse compatibility
    permissions: [], // Initialize permissions as empty array
    hardwareRequirements: [], // Initialize hardware requirements as empty array
  });

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaved, setIsSaved] = useState(false);
  const [isApiKeyDialogOpen, setIsApiKeyDialogOpen] = useState(false);
  const [isSharingDialogOpen, setIsSharingDialogOpen] = useState(false);
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
  const [previewPhotos, setPreviewPhotos] = useState<PhotoUploadItem[]>([]);
  const [originalPreviewPhotos, setOriginalPreviewPhotos] = useState<PhotoUploadItem[]>([]); // Track original images for deletion
  const [apiKey, setApiKey] = useState("");
  const [shareLink, setShareLink] = useState("");
  const [isRegeneratingKey, setIsRegeneratingKey] = useState(false);
  const [isLoadingShareLink, setIsLoadingShareLink] = useState(false);

  // State for organization transfer
  const [isMoveOrgDialogOpen, setIsMoveOrgDialogOpen] = useState(false);
  const [eligibleOrgs, setEligibleOrgs] = useState<Organization[]>([]);

  // State for import functionality
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [importConfigData, setImportConfigData] = useState<ImportConfigData | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [sameValueWarning, setSameValueWarning] = useState(false);

  // File input ref for import
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Track the previous organization to detect org switches
  const prevOrgRef = useRef<string | null>(null);

  // Fetch App data and check for eligible orgs for transfer
  useEffect(() => {
    const fetchData = async () => {
      if (!packageName || !selectedOrgId) return;

      // If organization changed from a previous one, we're switching orgs
      const isOrgSwitch = prevOrgRef.current && prevOrgRef.current !== selectedOrgId;
      prevOrgRef.current = selectedOrgId || null;

      try {
        setIsLoading(true);

        setError(null);

        // Fetch App data using store (org resolved server-side)
        const appData = await getApp(packageName);
        if (!appData) {
          throw new Error("App not found");
        }

        // Convert API response to App type
        const app: EditableApp = {
          packageName: appData.packageName,
          name: appData.name || "",
          description: appData.description || "",
          onboardingInstructions: appData.onboardingInstructions || "",
          publicUrl: appData.publicUrl || "",
          logoURL: appData.logoURL,
          webviewURL: appData.webviewURL,
          isPublic: appData.isPublic || false,
          appStoreStatus: appData.appStoreStatus || "DEVELOPMENT",
          appType: appData.appType || ("standard" as AppType),
          createdAt: appData.createdAt,
          updatedAt: appData.updatedAt,
          reviewNotes: appData.reviewNotes,
          reviewedBy: appData.reviewedBy,
          reviewedAt: appData.reviewedAt,
          tools: appData.tools || [],
          settings: appData.settings || [],
          permissions: appData.permissions || [],
          hardwareRequirements: appData.hardwareRequirements || [],
        };

        setFormData(app);

        // Load preview images if they exist
        if (appData.previewImages && Array.isArray(appData.previewImages)) {
          const loadedPhotos: PhotoUploadItem[] = appData.previewImages
            .sort((a: PreviewImage, b: PreviewImage) => a.order - b.order) // Sort by order
            .map((img: PreviewImage) => ({
              id: img.imageId || `${Date.now()}-${Math.random()}`,
              url: img.url,
              imageId: img.imageId,
              preview: img.url, // Use R2 URL as preview
              orientation: img.orientation,
              uploading: false,
            }));
          setPreviewPhotos(loadedPhotos);
          setOriginalPreviewPhotos(loadedPhotos); // Store original for comparison
        } else {
          setPreviewPhotos([]);
          setOriginalPreviewPhotos([]);
        }

        // Fetch all orgs where the user has admin access
        try {
          const allOrgs = await api.orgs.list();

          // Filter to only include orgs where the current account email is a member (admin or member)
          const email = accountEmail?.toLowerCase();
          const adminOrgs = allOrgs.filter((org) => {
            if (!Array.isArray(org.members) || !email) return false;
            return org.members.some((member) => {
              const role = member.role;
              const memberEmail =
                typeof member.user === "object" && member.user?.email ? member.user.email.toLowerCase() : null;
              return memberEmail === email && (role === "admin" || role === "member");
            });
          });
          setEligibleOrgs(adminOrgs);
        } catch (orgError) {
          console.error("Error fetching organizations:", orgError);
        }
      } catch (err: unknown) {
        console.error("Error fetching App:", err);

        // Check if the error indicates the app doesn't exist in this organization
        // This can happen when user switches orgs while editing an app
        const errObj = err as Record<string, unknown>;
        const resp = errObj["response"] as Record<string, unknown> | undefined;
        const status = resp?.["status"] as number | undefined;
        const data = resp?.["data"] as Record<string, unknown> | undefined;
        const respError = data?.["error"] as string | undefined;
        const msg = (errObj["message"] as string | undefined) ?? undefined;
        const isNotFoundError =
          status === 404 ||
          (typeof respError === "string" &&
            (respError.includes("not found") || respError.includes("does not exist"))) ||
          (typeof msg === "string" && msg.includes("not found"));

        if (isNotFoundError) {
          console.log("App not found in current organization, redirecting to app list...");

          // Only display toast on org switch
          if (!isOrgSwitch) {
            toast.error(`App "${packageName}" not found. Redirecting to app list...`);
          }

          // Redirect to app list
          navigate("/apps");
          return;
        }

        setError("Failed to load App data. Please try again.");
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [packageName, selectedOrgId, getApp, navigate, accountEmail]);

  // Handle form changes
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target as HTMLInputElement | HTMLTextAreaElement;

    // For URL fields, normalize on blur instead of on every keystroke
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
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

  // Handle settings changes
  const handleSettingsChange = (settings: Setting[]) => {
    setFormData((prev) => ({
      ...prev,
      settings,
    }));
  };

  // Handle tools changes
  const handleToolsChange = (tools: Tool[]) => {
    setFormData((prev) => ({
      ...prev,
      tools,
    }));
  };

  // Handle hardware requirements changes
  const handleHardwareRequirementsChange = (hardwareRequirements: HardwareRequirement[]) => {
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

  /**
   * Recursively removes _id fields and empty options/enum arrays from objects and arrays
   * Also removes id fields from settings (but not from tools where id is the tool identifier)
   * @param obj - The object or array to clean
   * @param isSettingsArray - Whether we're currently processing the settings array
   * @returns The cleaned object without unwanted fields and empty options/enum arrays
   */
  const removeIdFields = (obj: unknown, isSettingsArray: boolean = false): unknown => {
    if (Array.isArray(obj)) {
      return obj.map((item) => removeIdFields(item, isSettingsArray));
    } else if (obj !== null && typeof obj === "object") {
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        // Always skip _id fields
        // Skip id fields only if we're in a settings array
        if (key === "_id" || (key === "id" && isSettingsArray)) {
          continue;
        }

        // Skip empty options or enum arrays
        if ((key === "options" || key === "enum") && Array.isArray(value) && value.length === 0) {
          continue;
        }

        // When we encounter the settings key, mark that we're processing settings
        if (key === "settings" && Array.isArray(value)) {
          cleaned[key] = removeIdFields(value, true);
        } else {
          cleaned[key] = removeIdFields(value, isSettingsArray);
        }
      }
      return cleaned;
    }
    return obj;
  };

  // Export to app_config.json
  const handleExportConfig = () => {
    const config: Record<string, unknown> = {
      name: formData.name,
      description: formData.description,
      onboardingInstructions: formData.onboardingInstructions,
      publicUrl: formData.publicUrl || "",
      logoURL: formData.logoURL || "", // Cloudflare Images URL
      appType: formData.appType,
      permissions: removeIdFields(formData.permissions || []),
      settings: removeIdFields(formData.settings || [], true),
      tools: removeIdFields(formData.tools || []),
    };

    // Only include webviewURL if it exists and is not empty
    if (formData.webviewURL && formData.webviewURL.trim() !== "") {
      config.webviewURL = formData.webviewURL;
    }

    // Include preview images if they exist
    if (previewPhotos.length > 0) {
      config.previewImages = previewPhotos
        .filter((photo) => photo.url && photo.imageId) // Only include uploaded photos
        .map((photo, index) => ({
          url: photo.url,
          orientation: photo.orientation || "landscape",
          order: index,
        }));
    }

    const blob = new Blob([JSON.stringify(config, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${formData.packageName || "app"}_config.json`;
    a.click();
    URL.revokeObjectURL(url);

    toast.success("Configuration exported successfully!");
  };

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);
    setIsSaved(false);

    try {
      if (!packageName) throw new Error("Package name is missing");
      if (!currentOrg) throw new Error("No organization selected");
      if (sameValueWarning) throw new Error("Please resolve duplicate option values in settings before saving.");

      // Step 1: Upload new images (those with file but no url)
      const uploadedPhotos = [...previewPhotos];
      for (let i = 0; i < uploadedPhotos.length; i++) {
        const photo = uploadedPhotos[i];
        if (photo.file && !photo.url) {
          try {
            console.log("Uploading new image to R2:", photo.preview);
            const result = await api.images.upload(photo.file, {
              appPackageName: packageName,
            });

            // Update the photo with cloud storage URL and imageId
            uploadedPhotos[i] = {
              ...photo,
              url: result.url,
              imageId: result.imageId,
              file: undefined,
            };
          } catch (uploadError) {
            console.error("Failed to upload image:", uploadError);
            throw new Error("Failed to upload one or more images. Please try again.");
          }
        }
      }

      // Update state with uploaded photos
      setPreviewPhotos(uploadedPhotos);

      // Step 2: Determine which images to delete from R2
      // Images that were in originalPreviewPhotos but are NOT in uploadedPhotos
      const imagesToDelete = originalPreviewPhotos.filter(
        (originalPhoto) => !uploadedPhotos.some((currentPhoto) => currentPhoto.imageId === originalPhoto.imageId),
      );

      // Step 3: Delete removed images from R2
      for (const photoToDelete of imagesToDelete) {
        if (photoToDelete.imageId) {
          try {
            console.log("Deleting image from R2:", photoToDelete.imageId);
            await api.images.delete(photoToDelete.imageId);
          } catch (deleteError) {
            console.error("Failed to delete image from R2:", deleteError);
            // Continue even if deletion fails - image might already be deleted
          }
        }
      }

      // Step 4: Normalize URLs before submission
      const normalizedData = {
        name: formData.name,
        description: formData.description,
        onboardingInstructions: formData.onboardingInstructions,
        publicUrl: formData.publicUrl ? normalizeUrl(formData.publicUrl) : "",
        logoURL: formData.logoURL ? normalizeUrl(formData.logoURL) : "",
        webviewURL: formData.webviewURL ? normalizeUrl(formData.webviewURL) : "",
        appType: formData.appType,
        settings: formData.settings || [],
        tools: formData.tools || [],
        hardwareRequirements: formData.hardwareRequirements || [],
        permissions: formData.permissions || [],
        previewImages: uploadedPhotos
          .filter((photo) => photo.url && photo.imageId) // Only include uploaded photos
          .map((photo, index) => ({
            url: photo.url,
            imageId: photo.imageId || "",
            orientation: photo.orientation || "landscape",
            order: index,
          })),
      };

      // Step 5: Update App data via store action (server resolves org/admin)
      await updateApp(packageName, normalizedData);

      // Step 6: Update originalPreviewPhotos to match current state
      setOriginalPreviewPhotos([...uploadedPhotos]);

      // Show success message
      setIsSaved(true);
      toast.success("App updated successfully");

      // Reset saved status after 3 seconds
      setTimeout(() => {
        setIsSaved(false);
      }, 3000);
    } catch (err: unknown) {
      console.error("Error updating App:", err);

      // Extract the specific error message from the API response
      let errorMessage = "Failed to update app. Please try again.";

      // Safely narrow common HTTP error shapes
      if (typeof err === "object" && err !== null) {
        const maybeResponse = (err as { response?: { data?: { error?: string } } }).response;
        const maybeMessage = (err as { message?: string }).message;

        if (maybeResponse?.data?.error) {
          errorMessage = maybeResponse.data.error;
        } else if (typeof maybeMessage === "string" && maybeMessage) {
          errorMessage = maybeMessage;
        }
      }

      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsSaving(false);
    }
  };

  // Handle API key regeneration
  const handleRegenerateApiKey = async () => {
    try {
      if (!packageName) throw new Error("Package name is missing");

      setIsRegeneratingKey(true);
      setError(null);

      // Regenerate API key via store
      const response = await regenerateApiKeyStore(packageName);

      // Update local state with new API key
      setApiKey(response.apiKey);

      toast.success("API key regenerated successfully");
    } catch (err) {
      console.error("Error regenerating API key:", err);
      toast.error("Failed to regenerate API key");
    } finally {
      setIsRegeneratingKey(false);
    }
  };

  // Handle opening the API key dialog without regenerating
  const handleViewApiKey = () => {
    // We just open the dialog with the placeholder key
    // For security reasons, we don't fetch the real key
    setApiKey(""); // Use empty string to get placeholder

    // Clear any existing success messages
    setIsSaved(false);

    // Dismiss ALL existing toasts
    // Check if document is available (browser environment)
    if (typeof document !== "undefined") {
      const allToasts = document.querySelectorAll('[role="status"]');
      allToasts.forEach((toast) => {
        if (toast.parentElement) {
          toast.parentElement.removeChild(toast);
        }
      });
    }
    toast.dismiss();

    // Then open the dialog
    setIsApiKeyDialogOpen(true);
  };

  // Handle getting and copying share link
  const handleGetShareLink = async () => {
    try {
      if (!packageName) throw new Error("Package name is missing");

      setIsLoadingShareLink(true);
      setError(null);

      // TODO: Replace with apps.store getShareLink when wired
      // const { installUrl } = await getShareLinkStore(packageName);
      // setShareLink(installUrl);

      // Temporary: keep empty link until wired
      setShareLink("");

      // Open sharing dialog
      setIsSharingDialogOpen(true);
    } catch (err) {
      console.error("Error generating share link:", err);
      toast.error("Failed to generate sharing link");
    } finally {
      setIsLoadingShareLink(false);
    }
  };

  // Handle opening publish dialog
  const handleOpenPublishDialog = () => {
    setIsPublishDialogOpen(true);
  };

  // Handle successful publish (called after dialog completes)
  const handlePublishComplete = async () => {
    if (!packageName) return;

    try {
      // Refresh App data to get updated app status
      // Fetch App data using store (org resolved server-side)
      const appData = await getApp(packageName);
      if (!appData) {
        throw new Error("App not found");
      }

      // Update form data with new app status
      setFormData((prev) => ({
        ...prev,
        appStoreStatus: appData.appStoreStatus || prev.appStoreStatus,
      }));

      toast.success("Publication status updated");
    } catch (err) {
      console.error("Error refreshing App status:", err);
    }
  };

  // Handle App organization move
  const handleMoveToOrg = async (targetOrgId: string): Promise<void> => {
    if (!packageName) return;

    try {
      // Move App via store
      await moveAppStore(packageName, targetOrgId);

      // Show success message
      toast.success(`App moved to new organization successfully`);

      // Redirect to the Apps list after a short delay
      setTimeout(() => {
        navigate("/apps");
      }, 1500);
    } catch (err) {
      console.error("Error moving App to new organization:", err);
      throw new Error("Failed to move app to the new organization. Please try again.");
    }
  };

  /**
   * Validates a App configuration object structure and returns detailed error information
   * @param config - Object to validate
   * @returns Object with validation result and specific error message
   */
  const validateAppConfig = (config: Partial<ImportConfigData>): { isValid: boolean; error?: string } => {
    console.log("Validating config:", config);

    if (!config || typeof config !== "object") {
      console.log("Validation failed: config is not an object");
      return {
        isValid: false,
        error: "Configuration file must contain a valid JSON object.",
      };
    }

    // All fields are now optional - validate types only if they are provided

    // Name is optional but if present, must be a non-empty string
    if (config.name !== undefined && (typeof config.name !== "string" || config.name.trim() === "")) {
      console.log("Validation failed: name is present but invalid");
      return {
        isValid: false,
        error: 'Optional field "name" must be a non-empty string if provided.',
      };
    }

    // Description is optional but if present, must be a non-empty string
    if (
      config.description !== undefined &&
      (typeof config.description !== "string" || config.description.trim() === "")
    ) {
      console.log("Validation failed: description is present but invalid");
      return {
        isValid: false,
        error: 'Optional field "description" must be a non-empty string if provided.',
      };
    }

    // Version is optional but if present, must be a string
    if (config.version !== undefined && typeof config.version !== "string") {
      console.log("Validation failed: version is present but not a string");
      return {
        isValid: false,
        error: 'Optional field "version" must be a string if provided.',
      };
    }

    // Settings array is optional but if present, must be an array
    if (config.settings !== undefined && !Array.isArray(config.settings)) {
      console.log("Validation failed: settings is present but not an array");
      return {
        isValid: false,
        error: 'Optional field "settings" must be an array if provided.',
      };
    }

    // Optional fields validation - if present, must be correct type
    if (config.tools !== undefined && !Array.isArray(config.tools)) {
      console.log("Validation failed: tools is present but not an array");
      return {
        isValid: false,
        error: 'Optional field "tools" must be an array if provided.',
      };
    }

    if (config.permissions !== undefined && !Array.isArray(config.permissions)) {
      console.log("Validation failed: permissions is present but not an array");
      return {
        isValid: false,
        error: 'Optional field "permissions" must be an array if provided.',
      };
    }

    if (config.publicUrl !== undefined && (typeof config.publicUrl !== "string" || config.publicUrl.trim() === "")) {
      console.log("Validation failed: publicUrl is present but invalid");
      return {
        isValid: false,
        error: 'Optional field "publicUrl" must be a non-empty string if provided.',
      };
    }

    if (config.logoURL !== undefined && (typeof config.logoURL !== "string" || config.logoURL.trim() === "")) {
      console.log("Validation failed: logoURL is present but invalid");
      return {
        isValid: false,
        error: 'Optional field "logoURL" must be a non-empty string if provided.',
      };
    }

    // webviewURL can be empty string (treated as "not there"), but if present must be a string
    if (config.webviewURL !== undefined && typeof config.webviewURL !== "string") {
      console.log("Validation failed: webviewURL is present but not a string");
      return {
        isValid: false,
        error: 'Optional field "webviewURL" must be a string if provided.',
      };
    }

    // appType is optional but if present, must be a valid AppType value (excluding SYSTEM_DASHBOARD)
    if (config.appType !== undefined) {
      const validAppTypes = [AppType.BACKGROUND, AppType.STANDARD];
      if (!validAppTypes.includes(config.appType)) {
        console.log("Validation failed: appType is present but invalid");
        return {
          isValid: false,
          error: 'Optional field "appType" must be either "background" or "standard" if provided.',
        };
      }
    }

    // Validate each setting (but allow empty or missing settings array)
    if (config.settings && Array.isArray(config.settings)) {
      for (let index = 0; index < config.settings.length; index++) {
        const setting = config.settings[index];

        // Group settings just need a title
        if (setting.type === "group") {
          if (typeof setting.title !== "string") {
            console.log(`Validation failed: setting ${index} is a group but has invalid title`);
            return {
              isValid: false,
              error: `Setting ${index + 1}: Group type requires a "title" field with a string value.`,
            };
          }
          continue;
        }

        // TITLE_VALUE settings just need label and value
        const s = setting as {
          type?: string;
          label?: unknown;
          value?: unknown;
        };
        if (s.type === "titleValue") {
          if (typeof s.label !== "string") {
            console.log(`Validation failed: setting ${index} is titleValue but has invalid label`);
            return {
              isValid: false,
              error: `Setting ${index + 1}: TitleValue type requires a "label" field with a string value.`,
            };
          }
          if (!("value" in s)) {
            console.log(`Validation failed: setting ${index} is titleValue but has no value`);
            return {
              isValid: false,
              error: `Setting ${index + 1}: TitleValue type requires a "value" field.`,
            };
          }
          continue;
        }

        // Regular settings need key and label and type
        if (typeof setting.key !== "string" || typeof setting.label !== "string" || typeof setting.type !== "string") {
          console.log(`Validation failed: setting ${index} is missing key, label, or type`);
          return {
            isValid: false,
            error: `Setting ${index + 1}: Missing required fields "key", "label", or "type" (all must be strings).`,
          };
        }

        // Type-specific validation
        switch (setting.type) {
          case "toggle":
            if (setting.defaultValue !== undefined && typeof setting.defaultValue !== "boolean") {
              console.log(`Validation failed: setting ${index} is toggle but defaultValue is not boolean`);
              return {
                isValid: false,
                error: `Setting ${index + 1}: Toggle type requires "defaultValue" to be a boolean if provided.`,
              };
            }
            break;

          case "text":
          case "text_no_save_button":
            if (setting.defaultValue !== undefined && typeof setting.defaultValue !== "string") {
              console.log(`Validation failed: setting ${index} is text but defaultValue is not string`);
              return {
                isValid: false,
                error: `Setting ${index + 1}: Text type requires "defaultValue" to be a string if provided.`,
              };
            }
            break;

          case "select":
          case "select_with_search":
            if (!Array.isArray(setting.options)) {
              console.log(`Validation failed: setting ${index} is select but options is not an array`);
              return {
                isValid: false,
                error: `Setting ${index + 1}: Select type requires an "options" array.`,
              };
            }
            for (let optIndex = 0; optIndex < setting.options.length; optIndex++) {
              const opt = setting.options[optIndex];
              if (typeof opt.label !== "string" || !("value" in opt)) {
                console.log(`Validation failed: setting ${index} option ${optIndex} is invalid`);
                return {
                  isValid: false,
                  error: `Setting ${index + 1}, Option ${optIndex + 1}: Each option must have "label" (string) and "value" fields.`,
                };
              }
            }
            break;

          case "multiselect":
            if (!Array.isArray(setting.options)) {
              console.log(`Validation failed: setting ${index} is multiselect but options is not an array`);
              return {
                isValid: false,
                error: `Setting ${index + 1}: Multiselect type requires an "options" array.`,
              };
            }
            for (let optIndex = 0; optIndex < setting.options.length; optIndex++) {
              const opt = setting.options[optIndex];
              if (typeof opt.label !== "string" || !("value" in opt)) {
                console.log(`Validation failed: setting ${index} option ${optIndex} is invalid`);
                return {
                  isValid: false,
                  error: `Setting ${index + 1}, Option ${optIndex + 1}: Each option must have "label" (string) and "value" fields.`,
                };
              }
            }
            if (setting.defaultValue !== undefined && !Array.isArray(setting.defaultValue)) {
              console.log(`Validation failed: setting ${index} is multiselect but defaultValue is not array`);
              return {
                isValid: false,
                error: `Setting ${index + 1}: Multiselect type requires "defaultValue" to be an array if provided.`,
              };
            }
            break;

          case "slider":
            if (
              typeof setting.defaultValue !== "number" ||
              typeof setting.min !== "number" ||
              typeof setting.max !== "number" ||
              setting.min > setting.max
            ) {
              console.log(`Validation failed: setting ${index} is slider but has invalid numeric properties`);
              return {
                isValid: false,
                error: `Setting ${index + 1}: Slider type requires "defaultValue", "min", and "max" to be numbers, with min ≤ max.`,
              };
            }
            break;

          default:
            console.log(`Validation failed: setting ${index} has unknown type: ${setting.type}`);
            return {
              isValid: false,
              error: `Setting ${index + 1}: Unknown setting type "${setting.type}". Supported types: toggle, text, text_no_save_button, select, select_with_search, multiselect, slider, group, titleValue.`,
            };
        }
      }
    }

    console.log("Validation passed");
    return { isValid: true };
  };

  /**
   * Handles clicking the import configuration button
   */
  const handleImportClick = () => {
    // Reset state
    setImportConfigData(null);
    setImportError(null);

    // Trigger file input
    if (fileInputRef.current) {
      (fileInputRef.current as HTMLInputElement).click();
    }
  };

  /**
   * Handles file selection for import
   * @param event - File input change event
   */
  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];

    if (!file) return;

    // Reset any previous errors
    setImportError(null);

    // Validate file type
    if (!file.name.toLowerCase().endsWith(".json")) {
      setImportError("Please select a JSON file.");
      return;
    }

    // Read file content
    const reader = new FileReader();

    reader.onload = (e: ProgressEvent<FileReader>) => {
      try {
        const content = (e.target?.result as string) || "";

        if (!content || content.trim() === "") {
          setImportError("The selected file is empty.");
          return;
        }

        let config: ImportConfigData;
        try {
          config = JSON.parse(content);
        } catch (parseError) {
          console.error("JSON parse error:", parseError);
          setImportError("Invalid JSON format. Please check the file content.");
          return;
        }

        // Log the parsed config for debugging
        console.log("Parsed config:", config);

        // Validate configuration structure
        const validation = validateAppConfig(config);
        if (!validation.isValid) {
          console.error("Validation failed for config:", config);
          setImportError(validation.error || "Invalid app_config.json format.");
          return;
        }

        // Store config data and open confirmation dialog
        setImportConfigData(config);
        setImportError(null);
        setIsImportDialogOpen(true);
      } catch (error) {
        console.error("Error processing file:", error);
        setImportError("Failed to process the file. Please try again.");
      }
    };

    reader.onerror = (error: ProgressEvent<FileReader>) => {
      console.error("FileReader error:", error);
      setImportError("Failed to read the file. Please try again.");
    };

    reader.readAsText(file);

    // Reset file input
    target.value = "";
  };

  /**
   * Handles confirming the import of configuration
   */
  const handleImportConfirm = () => {
    if (!importConfigData) {
      console.error("No import config data available");
      return;
    }

    setIsImporting(true);

    try {
      console.log("Importing configuration:", importConfigData);

      // Update form data with imported configuration
      setFormData((prev) => {
        const newData = {
          ...prev,
          // Always update name and description if provided
          name: importConfigData.name || prev.name,
          description: importConfigData.description || prev.description,
          onboardingInstructions: importConfigData.onboardingInstructions || prev.onboardingInstructions,

          // Update URLs only if they are provided and not empty
          publicUrl:
            importConfigData.publicUrl !== undefined && importConfigData.publicUrl.trim() !== ""
              ? importConfigData.publicUrl.trim()
              : prev.publicUrl,
          // Note: logoURL from import will be a Cloudflare Images URL or other hosted URL
          logoURL:
            importConfigData.logoURL !== undefined && importConfigData.logoURL.trim() !== ""
              ? importConfigData.logoURL.trim()
              : prev.logoURL,
          // For webviewURL, treat empty strings as &quot;not there at all&quot; - only update if it has actual content
          webviewURL:
            importConfigData.webviewURL !== undefined &&
            typeof importConfigData.webviewURL === "string" &&
            importConfigData.webviewURL.trim() !== ""
              ? importConfigData.webviewURL.trim()
              : prev.webviewURL,

          // Update appType if provided, otherwise keep existing (defaults to BACKGROUND in form)
          appType: importConfigData.appType !== undefined ? (importConfigData.appType as AppType) : prev.appType,

          // Replace permissions if provided, otherwise keep existing
          permissions:
            importConfigData.permissions !== undefined ? importConfigData.permissions : prev.permissions || [],

          // Always replace settings and tools with imported data (can be empty arrays)
          settings: importConfigData.settings || [],
          tools: importConfigData.tools || [],
        };

        console.log("Updated form data:", newData);
        return newData;
      });

      // Import preview images if provided
      if (importConfigData.previewImages && Array.isArray(importConfigData.previewImages)) {
        const importedPhotos: PhotoUploadItem[] = importConfigData.previewImages
          .sort((a, b) => a.order - b.order) // Sort by order
          .map((img) => ({
            id: `imported-${Date.now()}-${Math.random()}`,
            url: img.url,
            imageId: "", // imageId not in exported config
            preview: img.url, // Use URL as preview
            orientation: img.orientation,
            uploading: false,
          }));
        setPreviewPhotos(importedPhotos);
      }

      // Close dialog and show success message
      setIsImportDialogOpen(false);
      setImportConfigData(null);
      toast.success("Configuration imported successfully! Remember to save changes.");
    } catch (error) {
      console.error("Error importing configuration:", error);
      toast.error("Failed to import configuration. Please try again.");
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center mb-6">
          <Link to="/apps" className="flex items-center text-sm text-gray-500 hover:text-gray-700">
            <ArrowLeftIcon className="mr-1 h-4 w-4" />
            Back to apps
          </Link>
        </div>

        <Card className="shadow-sm">
          {isLoading ? (
            <div className="p-8 text-center">
              <div className="animate-spin mx-auto h-8 w-8 border-t-2 border-b-2 border-blue-500 rounded-full"></div>
              <p className="mt-2 text-gray-500">Loading app data...</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <CardHeader>
                <CardTitle className="text-2xl">Edit App</CardTitle>
                <CardDescription>Update your app&apos;s configuration.</CardDescription>
                {currentOrg && (
                  <div className="mt-2 mb-2 text-sm flex items-center justify-between">
                    <div>
                      <span className="text-gray-500">Organization: </span>
                      <span className="font-medium">{currentOrg.name}</span>
                    </div>

                    {/* Move Organization button - only show if user has admin access to multiple orgs */}
                    {eligibleOrgs.length > 1 && (
                      <Button
                        onClick={() => setIsMoveOrgDialogOpen(true)}
                        className="gap-2"
                        type="button"
                        variant="outline"
                        size="sm">
                        <MoveIcon className="h-4 w-4" />
                        Switch Organization
                      </Button>
                    )}
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-6 pb-5">
                {error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                {isSaved && (
                  <Alert className="bg-green-50 text-green-800 border-green-200">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <AlertDescription className="text-green-700">App updated successfully!</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <Label htmlFor="packageName">Package Name</Label>
                  <Input
                    id="packageName"
                    name="packageName"
                    value={formData.packageName}
                    disabled
                    className="bg-gray-50"
                  />
                  <p className="text-xs text-gray-500">Package names cannot be changed after creation.</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="name">Display Name</Label>
                  <Input
                    id="name"
                    name="name"
                    value={formData.name}
                    onChange={handleChange}
                    placeholder="e.g., My Awesome App"
                  />
                  <p className="text-xs text-gray-500">
                    The name that will be displayed to users in the MentraOS app store.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    name="description"
                    value={formData.description}
                    onChange={handleChange}
                    placeholder="Describe what your app does..."
                    rows={3}
                  />
                  <p className="text-xs text-gray-500">
                    Provide a clear, concise description of your application&apos;s functionality.
                  </p>
                </div>

                {/* Onboarding Instructions Section */}
                <div className="space-y-2">
                  <Label htmlFor="onboardingInstructions">Onboarding Instructions (Optional)</Label>
                  <Textarea
                    id="onboardingInstructions"
                    name="onboardingInstructions"
                    value={formData.onboardingInstructions || ""}
                    onChange={handleChange}
                    placeholder="Describe the onboarding steps for your app"
                    rows={3}
                    maxLength={2000}
                    style={{ maxHeight: "8em", overflowY: "auto" }}
                  />
                  <p className="text-xs text-gray-500">
                    Provide onboarding instructions that will be shown to users the first time they launch your app.
                    Maximum 5 lines.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="publicUrl">Server URL</Label>
                  <Input
                    id="publicUrl"
                    name="publicUrl"
                    value={formData.publicUrl}
                    onChange={handleChange}
                    onBlur={handleUrlBlur}
                    placeholder="yourserver.com"
                  />
                  <p className="text-xs text-gray-500">
                    The base URL of your server where MentraOS will communicate with your app. We&apos;ll automatically
                    append &quot;/webhook&quot; to handle events when your app is activated. HTTPS is required and will
                    be added automatically if not specified. Do not include a trailing slash - it will be automatically
                    removed.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="logoURL">Logo URL</Label>
                  <ImageUpload
                    currentImageUrl={formData.logoURL}
                    onImageUploaded={(url) => {
                      setFormData((prev) => ({
                        ...prev,
                        logoURL: url,
                      }));
                    }}
                    packageName={formData.packageName}
                    disabled={isSaving}
                  />
                  {/* Note: The actual Cloudflare URL is stored in logoURL but not displayed to the user */}
                  <p className="text-xs text-gray-500">
                    Upload an image that will be used as your app&apos;s icon (recommended: 512x512 PNG).
                  </p>
                </div>
                {/* Preview Images */}
                <div className="space-y-2">
                  <Label>Preview Images</Label>
                  <MultiPhotoUpload
                    photos={previewPhotos}
                    onChange={setPreviewPhotos}
                    packageName={formData.packageName}
                    maxPhotos={8}
                    disabled={isSaving}
                  />
                  <p className="text-xs text-gray-500">
                    Upload up to 8 images for your app preview (recommended: 16:9 aspect ratio).
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="webviewURL">Webview URL (Optional)</Label>
                  <Input
                    id="webviewURL"
                    name="webviewURL"
                    value={formData.webviewURL || ""}
                    onChange={handleChange}
                    onBlur={handleUrlBlur}
                    placeholder="yourserver.com/webview"
                  />
                  <p className="text-xs text-gray-500">
                    If your app has a companion mobile interface, provide the URL here. HTTPS is required and will be
                    added automatically if not specified.
                  </p>
                </div>

                {/* App Type Selection */}
                <div className="space-y-2 pb-5">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="appType">App Type</Label>
                    <AppTypeTooltip />
                  </div>
                  <p className="text-xs text-gray-500">
                    <br />
                    Background apps can run alongside other apps,
                    <br />
                    Only 1 foreground app can run at a time.
                    <br />
                    foreground apps yield the display to background apps when displaying content.
                  </p>
                  <Select value={formData.appType} onValueChange={handleAppTypeChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select app type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={AppType.BACKGROUND}>
                        <div className="flex flex-col">
                          <span className="font-medium">Background App</span>
                          {/* <span className="text-xs text-gray-500">Multiple can run simultaneously</span> */}
                        </div>
                      </SelectItem>
                      <SelectItem value={AppType.STANDARD}>
                        <div className="flex flex-col">
                          <span className="font-medium">Foreground App</span>
                          {/* <span className="text-xs text-gray-500">Only one can run at a time</span> */}
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Permissions Section */}
                <div className="border rounded-md p-4 mt-6">
                  <PermissionsForm permissions={formData.permissions || []} onChange={handlePermissionsChange} />
                </div>

                {/* Hardware Requirements Section */}
                <div className="border rounded-md p-4 mt-6">
                  <HardwareRequirementsForm
                    requirements={formData.hardwareRequirements || []}
                    onChange={handleHardwareRequirementsChange}
                  />
                </div>

                {/* Settings Section */}
                <div className="border rounded-md p-4 mt-6">
                  <SettingsEditor
                    settings={formData.settings || []}
                    onChange={handleSettingsChange}
                    setSameValueWarning={setSameValueWarning}
                    toast={toast}
                  />
                </div>

                {/* Tools Section */}
                <div className="border rounded-md p-4 mt-6">
                  <ToolsEditor tools={formData.tools || []} onChange={handleToolsChange} />
                </div>

                {/* Share with Testers Section */}
                <div className="border rounded-md p-4 mt-6">
                  <h3 className="text-lg font-medium mb-2 flex items-center">
                    <LinkIcon className="h-5 w-5 mr-2" />
                    Share with Testers
                  </h3>
                  <p className="text-sm text-gray-600 mb-4">
                    Anyone with this link can access and test the app (read-only access).
                  </p>
                  <div className="flex items-center justify-end">
                    <Button
                      onClick={handleGetShareLink}
                      className="gap-2"
                      type="button"
                      variant="outline"
                      disabled={isLoadingShareLink}>
                      {isLoadingShareLink ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading...
                        </>
                      ) : (
                        <>
                          <LinkIcon className="h-4 w-4" />
                          Share App
                        </>
                      )}
                    </Button>
                  </div>
                  {shareLink && (
                    <div className="mt-3 p-2 bg-gray-50 rounded border">
                      <p className="text-xs text-gray-500 mb-1">Share Link:</p>
                      <span className="text-xs text-blue-600 break-all">{shareLink}</span>
                    </div>
                  )}
                </div>

                {/* API Key section */}
                <div className="border rounded-md p-4 mt-6">
                  <h3 className="text-lg font-medium mb-2 flex items-center">
                    <KeyRound className="h-5 w-5 mr-2" />
                    API Key
                  </h3>

                  <p className="text-sm text-gray-600 mb-4">
                    Your API key is used to authenticate your app with MentraOS cloud services. Keep it secure and never
                    share it publicly.
                  </p>

                  <div className="flex items-center justify-end">
                    <Button
                      onClick={handleViewApiKey}
                      className="mr-2"
                      variant="outline" /* Explicitly set type to button to prevent form submission */
                    >
                      View Key
                    </Button>

                    <Button
                      onClick={handleRegenerateApiKey}
                      disabled={isRegeneratingKey}
                      variant="secondary"
                      type="button" /* Explicitly set type to button to prevent form submission */
                    >
                      {isRegeneratingKey ? (
                        <>
                          <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                          Regenerating...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Regenerate Key
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {/* Status information */}
                <div className="border rounded-md p-4 mt-6">
                  <h3 className="text-lg font-medium mb-2 flex items-center">
                    <Upload className="h-5 w-5 mr-2" />
                    App Status:{" "}
                    {formData.appStoreStatus === "DEVELOPMENT"
                      ? "Development"
                      : formData.appStoreStatus === "SUBMITTED"
                        ? "Submitted for Review"
                        : formData.appStoreStatus === "REJECTED"
                          ? "Rejected"
                          : formData.appStoreStatus === "PUBLISHED"
                            ? "Published"
                            : "Development"}
                  </h3>

                  <p className="text-sm text-gray-600 mb-4">
                    {formData.appStoreStatus === "DEVELOPMENT"
                      ? "Your app is currently in development. Publish it when ready to submit for review."
                      : formData.appStoreStatus === "SUBMITTED"
                        ? "Your app has been submitted for review. Once approved, it will be published to the App Store."
                        : formData.appStoreStatus === "REJECTED"
                          ? "Your app has been rejected. Please review the feedback and make the necessary changes before resubmitting."
                          : "Your app is published and available to all MentraOS users in the App Store."}
                  </p>

                  {formData.appStoreStatus === "REJECTED" && formData.reviewNotes && (
                    <div className="bg-red-50 border border-red-200 rounded-md p-3 mt-2 mb-4">
                      <h4 className="text-sm font-medium text-red-800 mb-1">Rejection Reason:</h4>
                      <p className="text-sm text-red-700">{formData.reviewNotes}</p>
                      {formData.reviewedAt && (
                        <p className="text-xs text-red-500 mt-2">
                          Reviewed on {new Date(formData.reviewedAt).toLocaleDateString()} by{" "}
                          {formData.reviewedBy?.split("@")[0] || "Admin"}
                        </p>
                      )}
                    </div>
                  )}

                  {(formData.appStoreStatus === "DEVELOPMENT" || formData.appStoreStatus === "REJECTED") && (
                    <div className="flex items-center justify-end">
                      <Button onClick={handleOpenPublishDialog} className="gap-2" type="button">
                        <Upload className="h-4 w-4" />
                        {formData.appStoreStatus === "REJECTED" ? "Resubmit to App Store" : "Publish to App Store"}
                      </Button>
                    </div>
                  )}
                </div>

                {/* Import/Export Configuration Section */}
                <div className="border rounded-md p-4 mt-6">
                  <h3 className="text-lg font-medium mb-2 flex items-center">
                    <Files className="h-5 w-5 mr-2" />
                    Configuration Management
                  </h3>
                  <p className="text-sm text-gray-600 mb-4">
                    Import or export your app configuration (name, description, URLs, permissions, settings, and tools)
                    as a app_config.json file
                  </p>

                  {/* Show import error if there is one and no dialog is open */}
                  {importError && !isImportDialogOpen && (
                    <Alert variant="destructive" className="mb-4">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>{importError}</AlertDescription>
                    </Alert>
                  )}

                  <div className="flex items-center justify-end">
                    <Button onClick={handleImportClick} variant="outline" type="button" className="mr-2">
                      <Download className="h-4 w-4 mr-2" />
                      Import app_config.json
                    </Button>
                    <Button onClick={handleExportConfig} variant="outline" type="button">
                      <Upload className="h-4 w-4 mr-2" />
                      Export app_config.json
                    </Button>
                  </div>

                  {/* Hidden file input for import */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    onChange={handleFileSelect}
                    style={{ display: "none" }}
                  />
                </div>
              </CardContent>
              <CardFooter className="flex justify-between border-t p-6">
                <Button variant="outline" type="button" onClick={() => navigate("/apps")}>
                  Back
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
              </CardFooter>
            </form>
          )}
        </Card>
      </div>

      {/* Dialogs */}
      {packageName && (
        <>
          <ApiKeyDialog
            app={formData}
            open={isApiKeyDialogOpen}
            onOpenChange={setIsApiKeyDialogOpen}
            apiKey={apiKey}
            orgId={currentOrg?.id}
          />

          <SharingDialog
            app={formData}
            open={isSharingDialogOpen}
            onOpenChange={setIsSharingDialogOpen}
            orgId={currentOrg?.id}
          />

          <PublishDialog
            app={formData}
            open={isPublishDialogOpen}
            onOpenChange={(open) => {
              setIsPublishDialogOpen(open);
            }}
            onPublishComplete={handlePublishComplete}
            orgId={currentOrg?.id}
          />

          {currentOrg && (
            <MoveOrgDialog
              app={formData}
              open={isMoveOrgDialogOpen}
              onOpenChange={setIsMoveOrgDialogOpen}
              eligibleOrgs={eligibleOrgs}
              currentOrgId={currentOrg.id}
              onMoveComplete={() => {
                // Handled by redirect in handleMoveToOrg
              }}
              onMove={async (targetOrgId) => {
                await handleMoveToOrg(targetOrgId);
              }}
            />
          )}
        </>
      )}

      {/* Import Dialog - separate from packageName condition */}
      <ImportConfigDialog
        open={isImportDialogOpen}
        onOpenChange={setIsImportDialogOpen}
        configData={importConfigData}
        onConfirm={handleImportConfirm}
        isImporting={isImporting}
        error={importError || undefined}
      />
    </DashboardLayout>
  );
}

// default export moved to function declaration above
