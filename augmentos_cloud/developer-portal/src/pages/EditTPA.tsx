// pages/EditTPA.tsx
import React, { useState, useEffect, useRef } from 'react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeftIcon, CheckCircle2, AlertCircle, Loader2, KeyRound, Copy, RefreshCw, Share2, LinkIcon, Upload, MoveIcon, Download, Files } from "lucide-react";
import DashboardLayout from "../components/DashboardLayout";
import api, { Organization } from '@/services/api.service';
import { TPA, Permission, Setting, Tool } from '@/types/tpa';
import { toast } from 'sonner';
import ApiKeyDialog from '../components/dialogs/ApiKeyDialog';
import SharingDialog from '../components/dialogs/SharingDialog';
import PublishDialog from '../components/dialogs/PublishDialog';
import ImportConfigDialog from '../components/dialogs/ImportConfigDialog';
import { normalizeUrl } from '@/libs/utils';
import PermissionsForm from '../components/forms/PermissionsForm';
import SettingsEditor from '../components/forms/SettingsEditor';
import ToolsEditor from '../components/forms/ToolsEditor';
import { useAuth } from '../hooks/useAuth';
import { useOrganization } from '@/context/OrganizationContext';
// import publicEmailDomains from 'email-providers/all.json';
import MoveOrgDialog from '../components/dialogs/MoveOrgDialog';
import ImageUpload from '../components/forms/ImageUpload';
import TpaTypeTooltip from '../components/forms/TpaTypeTooltip';
// import { TpaType } from '@mentra/sdk';

enum TpaType {
  STANDARD = 'standard',
  BACKGROUND = 'background'
}
// Extend TPA type locally to include sharedWithOrganization
interface EditableTPA extends TPA {
  sharedWithOrganization?: boolean;
}

const EditTPA: React.FC = () => {
  const navigate = useNavigate();
  const { packageName } = useParams<{ packageName: string }>();
  const { user } = useAuth();
  const { currentOrg } = useOrganization();

  // Form state
  const [formData, setFormData] = useState<EditableTPA>({
    id: '',
    packageName: '',
    name: '',
    description: '',
    onboardingInstructions: '',
    publicUrl: '',
    logoURL: '',
    isPublic: false,
    appStoreStatus: 'DEVELOPMENT',
    tpaType: 'standard' as TpaType, // Default value for TpaType with cast
    createdAt: new Date().toISOString(), // Default value for AppResponse compatibility
    updatedAt: new Date().toISOString(), // Default value for AppResponse compatibility
    permissions: [], // Initialize permissions as empty array
  });

  // Permissions state
  const [isLoadingPermissions, setIsLoadingPermissions] = useState(false);

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaved, setIsSaved] = useState(false);
  const [isApiKeyDialogOpen, setIsApiKeyDialogOpen] = useState(false);
  const [isSharingDialogOpen, setIsSharingDialogOpen] = useState(false);
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [shareLink, setShareLink] = useState('');
  const [isRegeneratingKey, setIsRegeneratingKey] = useState(false);
  const [isLoadingShareLink, setIsLoadingShareLink] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);

  // Add sharedWithEmails state
  const [sharedWithEmails, setSharedWithEmails] = useState<string[]>([]);
  const [newShareEmail, setNewShareEmail] = useState('');
  const [isUpdatingEmails, setIsUpdatingEmails] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  // State for organization transfer
  const [isMoveOrgDialogOpen, setIsMoveOrgDialogOpen] = useState(false);
  const [eligibleOrgs, setEligibleOrgs] = useState<Organization[]>([]);
  const [isMovingOrg, setIsMovingOrg] = useState(false);

  // State for import functionality
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [importConfigData, setImportConfigData] = useState<any>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // File input ref for import
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Helper to get org domain from user email
  const orgDomain = user?.email?.split('@')[1] || '';
  // Check if orgDomain is a public email provider
  // const isPublicEmailDomain = publicEmailDomains.includes(orgDomain);

  // Fetch TPA data and permissions from API + check for eligible orgs for transfer
  useEffect(() => {
    const fetchData = async () => {
      if (!packageName || !currentOrg) return;

      try {
        setIsLoading(true);
        setIsLoadingPermissions(true);
        setError(null);

        // Fetch TPA data using organization ID
        const tpaData = await api.apps.getByPackageName(packageName, currentOrg.id);

        // Convert API response to TPA type
        const tpa: EditableTPA = {
          id: tpaData.packageName, // Using packageName as id since API doesn't return id
          packageName: tpaData.packageName,
          name: tpaData.name,
          description: tpaData.description || '',
          onboardingInstructions: tpaData.onboardingInstructions || '',
          publicUrl: tpaData.publicUrl || '',
          logoURL: tpaData.logoURL,
          webviewURL: tpaData.webviewURL,
          isPublic: tpaData.isPublic || false,
          appStoreStatus: tpaData.appStoreStatus || 'DEVELOPMENT',
          tpaType: tpaData.tpaType || ('standard' as TpaType),
          createdAt: tpaData.createdAt,
          updatedAt: tpaData.updatedAt,
          reviewNotes: tpaData.reviewNotes,
          reviewedBy: tpaData.reviewedBy,
          reviewedAt: tpaData.reviewedAt,
          tools: tpaData.tools || [],
          settings: tpaData.settings || [],
        };

        setFormData(tpa);

        // Fetch permissions
        try {
          const permissionsData = await api.apps.permissions.get(packageName);
          if (permissionsData.permissions) {
            setFormData(prev => ({ ...prev, permissions: permissionsData.permissions }));
          }
        } catch (permError) {
          console.error('Error fetching permissions:', permError);
          // Don't fail the whole form load if permissions fail
        } finally {
          setIsLoadingPermissions(false);
        }

        // Set sharedWithEmails
        if (Array.isArray(tpaData.sharedWithEmails)) {
          setSharedWithEmails(tpaData.sharedWithEmails);
        }

        // Fetch all orgs where the user has admin access
        try {
          const allOrgs = await api.orgs.list();

          // Get the user's full profile to access ID
          let userId = '';
          try {
            const userProfile = await api.auth.me();
            userId = userProfile.id;
            console.log("Current user ID:", userId);
          } catch (err) {
            console.error("Failed to fetch user profile:", err);
          }

          // Filter to only include orgs where the user has admin/owner access
          const adminOrgs = allOrgs.filter(org => {

            // Handle member structure
            if (Array.isArray(org.members)) {
              for (const member of org.members) {
                const role = member.role;

                // Case 1: Direct string comparison with user ID
                if (userId && typeof member.user === 'string' && member.user === userId) {
                  return role === 'admin' || role === 'member';
                }

                // Case 2: Compare with user object with email
                if (typeof member.user === 'object' && member.user && member.user.email === user?.email) {
                  return role === 'admin' || role === 'member';
                }
              }
            }
            return false;
          });
          setEligibleOrgs(adminOrgs);
        } catch (orgError) {
          console.error('Error fetching organizations:', orgError);
        }
      } catch (err) {
        console.error('Error fetching TPA:', err);
        setError('Failed to load TPA data. Please try again.');
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [packageName, currentOrg?.id, user?.email]);

  // Handle form changes
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target as HTMLInputElement | HTMLTextAreaElement;

    // For URL fields, normalize on blur instead of on every keystroke
    setFormData(prev => ({
      ...prev,
      [name]: value
    }));
  };

  // Handle URL field blur event to normalize URLs
  const handleUrlBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const { name, value } = e.currentTarget;

    // Only normalize URL fields
    if (name === 'publicUrl' || name === 'logoURL' || name === 'webviewURL') {
      if (value) {
        try {
          // Normalize the URL and update the form field
          const normalizedUrl = normalizeUrl(value);
          setFormData(prev => ({
            ...prev,
            [name]: normalizedUrl
          }));
        } catch (error) {
          console.error(`Error normalizing ${name}:`, error);
        }
      }
    }
  };

  // Handle permissions changes
  const handlePermissionsChange = (permissions: Permission[]) => {
    setFormData(prev => ({
      ...prev,
      permissions
    }));
  };

  // Handle settings changes
  const handleSettingsChange = (settings: Setting[]) => {
    setFormData(prev => ({
      ...prev,
      settings
    }));
  };

  // Handle tools changes
  const handleToolsChange = (tools: Tool[]) => {
    setFormData(prev => ({
      ...prev,
      tools
    }));
  };

  // Handle TpaType changes
  const handleTpaTypeChange = (value: string) => {
    setFormData(prev => ({
      ...prev,
      tpaType: value as TpaType
    }));
  };

  /**
   * Recursively removes _id fields and empty options/enum arrays from objects and arrays
   * Also removes id fields from settings (but not from tools where id is the tool identifier)
   * @param obj - The object or array to clean
   * @param isSettingsArray - Whether we're currently processing the settings array
   * @returns The cleaned object without unwanted fields and empty options/enum arrays
   */
  const removeIdFields = (obj: any, isSettingsArray: boolean = false): any => {
    if (Array.isArray(obj)) {
      return obj.map(item => removeIdFields(item, isSettingsArray));
    } else if (obj !== null && typeof obj === 'object') {
      const cleaned: any = {};
      for (const [key, value] of Object.entries(obj)) {
        // Always skip _id fields
        // Skip id fields only if we're in a settings array
        if (key === '_id' || (key === 'id' && isSettingsArray)) {
          continue;
        }

        // Skip empty options or enum arrays
        if ((key === 'options' || key === 'enum') && Array.isArray(value) && value.length === 0) {
          continue;
        }

        // When we encounter the settings key, mark that we're processing settings
        if (key === 'settings' && Array.isArray(value)) {
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
    const config: any = {
      name: formData.name,
      description: formData.description,
      onboardingInstructions: formData.onboardingInstructions,
      publicUrl: formData.publicUrl || '',
      logoURL: formData.logoURL || '', // Cloudflare Images URL
      tpaType: formData.tpaType,
      permissions: removeIdFields(formData.permissions || []),
      settings: removeIdFields(formData.settings || [], true),
      tools: removeIdFields(formData.tools || [])
    };

    // Only include webviewURL if it exists and is not empty
    if (formData.webviewURL && formData.webviewURL.trim() !== '') {
      config.webviewURL = formData.webviewURL;
    }

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${formData.packageName || 'tpa'}_config.json`;
    a.click();
    URL.revokeObjectURL(url);

    toast.success('Configuration exported successfully!');
  };

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);
    setIsSaved(false);

    try {
      if (!packageName) throw new Error('Package name is missing');
      if (!currentOrg) throw new Error('No organization selected');

      // Normalize URLs before submission
      const normalizedData = {
        name: formData.name,
        description: formData.description,
        onboardingInstructions: formData.onboardingInstructions,
        publicUrl: formData.publicUrl ? normalizeUrl(formData.publicUrl) : '',
        logoURL: formData.logoURL ? normalizeUrl(formData.logoURL) : '',
        webviewURL: formData.webviewURL ? normalizeUrl(formData.webviewURL) : '',
        tpaType: formData.tpaType,
        settings: formData.settings || [],
        tools: formData.tools || []
      };

      // Update TPA data
      await api.apps.update(packageName, normalizedData, currentOrg.id);

      // Update permissions
      if (formData.permissions) {
        await api.apps.permissions.update(packageName, formData.permissions);
      }

      // Show success message
      setIsSaved(true);
      toast.success('App updated successfully');

      // Reset saved status after 3 seconds
      setTimeout(() => {
        setIsSaved(false);
      }, 3000);
    } catch (err: any) {
      console.error('Error updating TPA:', err);

      // Extract the specific error message from the API response
      let errorMessage = 'Failed to update app. Please try again.';

      if (err?.response?.data?.error) {
        // API returned a specific error message
        errorMessage = err.response.data.error;
      } else if (err?.message) {
        // Use the error message if available
        errorMessage = err.message;
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
      if (!packageName) throw new Error('Package name is missing');
      if (!currentOrg) throw new Error('No organization selected');

      setIsRegeneratingKey(true);
      setError(null);

      // Regenerate API key via API
      const response = await api.apps.apiKey.regenerate(packageName, currentOrg.id);

      // Update local state with new API key
      setApiKey(response.apiKey);

      toast.success('API key regenerated successfully');
    } catch (err) {
      console.error('Error regenerating API key:', err);
      toast.error('Failed to regenerate API key');
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
    if (typeof document !== 'undefined') {
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
      if (!packageName) throw new Error('Package name is missing');
      if (!currentOrg) throw new Error('No organization selected');

      setIsLoadingShareLink(true);
      setError(null);

      // Get share link via API
      const shareUrl = await api.sharing.getInstallLink(packageName, currentOrg.id);

      // Update local state with share link
      setShareLink(shareUrl);

      // Open sharing dialog
      setIsSharingDialogOpen(true);
    } catch (err) {
      console.error('Error generating share link:', err);
      toast.error('Failed to generate sharing link');
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
    if (!packageName || !currentOrg) return;

    try {
      // Refresh TPA data to get updated app status
      const updatedTpa = await api.apps.getByPackageName(packageName, currentOrg.id);

      // Update form data with new app status
      setFormData(prev => ({
        ...prev,
        appStoreStatus: updatedTpa.appStoreStatus || prev.appStoreStatus
      }));

      toast.success('Publication status updated');
    } catch (err) {
      console.error('Error refreshing TPA status:', err);
    }
  };

  // Handler to add a new email to the share list
  const handleAddShareEmail = async () => {
    try {
      if (!packageName) throw new Error('Package name is missing');
      if (!currentOrg) throw new Error('No organization selected');
      if (!newShareEmail.trim()) return;

      setIsUpdatingEmails(true);
      setEmailError(null);

      // Validate email
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(newShareEmail)) {
        setEmailError('Please enter a valid email address');
        setIsUpdatingEmails(false);
        return;
      }

      // Check if email already in list
      if (sharedWithEmails.includes(newShareEmail)) {
        setEmailError('This email is already in the list');
        setIsUpdatingEmails(false);
        return;
      }

      // Update emails via API
      const updatedEmails = [...sharedWithEmails, newShareEmail];
      await api.apps.updateSharedEmails(packageName, updatedEmails);

      // Update local state
      setSharedWithEmails(updatedEmails);
      setNewShareEmail('');

      toast.success(`Shared with ${newShareEmail}`);

      // Also track via the sharing API
      await api.sharing.trackSharing(packageName, [newShareEmail], currentOrg.id);
    } catch (err) {
      console.error('Error adding share email:', err);
      toast.error('Failed to add email');
    } finally {
      setIsUpdatingEmails(false);
    }
  };

  // Handler to remove an email from the share list
  const handleRemoveShareEmail = async (email: string) => {
    try {
      if (!packageName) throw new Error('Package name is missing');
      if (!currentOrg) throw new Error('No organization selected');

      setIsUpdatingEmails(true);

      // Filter out the email to remove
      const updatedEmails = sharedWithEmails.filter(e => e !== email);

      // Update emails via API
      await api.apps.updateSharedEmails(packageName, updatedEmails);

      // Update local state
      setSharedWithEmails(updatedEmails);

      toast.success(`Removed ${email} from shared list`);
    } catch (err) {
      console.error('Error removing share email:', err);
      toast.error('Failed to remove email');
    } finally {
      setIsUpdatingEmails(false);
    }
  };

  // Handle TPA organization move
  const handleMoveToOrg = async (targetOrgId: string) => {
    if (!packageName || !currentOrg) return;

    try {
      setIsMovingOrg(true);

      // Call API to move TPA to the target organization
      await api.apps.moveToOrg(packageName, targetOrgId, currentOrg.id);

      // Show success message
      toast.success(`App moved to new organization successfully`);

      // Redirect to the TPAs list after a short delay
      setTimeout(() => {
        navigate('/tpas');
      }, 1500);
    } catch (err) {
      console.error('Error moving TPA to new organization:', err);
      throw new Error('Failed to move app to the new organization. Please try again.');
    } finally {
      setIsMovingOrg(false);
    }
  };

  /**
   * Validates a TPA configuration object structure and returns detailed error information
   * @param config - Object to validate
   * @returns Object with validation result and specific error message
   */
  const validateTpaConfig = (config: any): { isValid: boolean; error?: string } => {
    console.log('Validating config:', config);

    if (!config || typeof config !== 'object') {
      console.log('Validation failed: config is not an object');
      return { isValid: false, error: 'Configuration file must contain a valid JSON object.' };
    }

    // All fields are now optional - validate types only if they are provided

    // Name is optional but if present, must be a non-empty string
    if (config.name !== undefined && (typeof config.name !== 'string' || config.name.trim() === '')) {
      console.log('Validation failed: name is present but invalid');
      return { isValid: false, error: 'Optional field "name" must be a non-empty string if provided.' };
    }

    // Description is optional but if present, must be a non-empty string
    if (config.description !== undefined && (typeof config.description !== 'string' || config.description.trim() === '')) {
      console.log('Validation failed: description is present but invalid');
      return { isValid: false, error: 'Optional field "description" must be a non-empty string if provided.' };
    }

    // Version is optional but if present, must be a string
    if (config.version !== undefined && typeof config.version !== 'string') {
      console.log('Validation failed: version is present but not a string');
      return { isValid: false, error: 'Optional field "version" must be a string if provided.' };
    }

    // Settings array is optional but if present, must be an array
    if (config.settings !== undefined && !Array.isArray(config.settings)) {
      console.log('Validation failed: settings is present but not an array');
      return { isValid: false, error: 'Optional field "settings" must be an array if provided.' };
    }

    // Optional fields validation - if present, must be correct type
    if (config.tools !== undefined && !Array.isArray(config.tools)) {
      console.log('Validation failed: tools is present but not an array');
      return { isValid: false, error: 'Optional field "tools" must be an array if provided.' };
    }

    if (config.permissions !== undefined && !Array.isArray(config.permissions)) {
      console.log('Validation failed: permissions is present but not an array');
      return { isValid: false, error: 'Optional field "permissions" must be an array if provided.' };
    }

    if (config.publicUrl !== undefined && (typeof config.publicUrl !== 'string' || config.publicUrl.trim() === '')) {
      console.log('Validation failed: publicUrl is present but invalid');
      return { isValid: false, error: 'Optional field "publicUrl" must be a non-empty string if provided.' };
    }

    if (config.logoURL !== undefined && (typeof config.logoURL !== 'string' || config.logoURL.trim() === '')) {
      console.log('Validation failed: logoURL is present but invalid');
      return { isValid: false, error: 'Optional field "logoURL" must be a non-empty string if provided.' };
    }

    // webviewURL can be empty string (treated as "not there"), but if present must be a string
    if (config.webviewURL !== undefined && typeof config.webviewURL !== 'string') {
      console.log('Validation failed: webviewURL is present but not a string');
      return { isValid: false, error: 'Optional field "webviewURL" must be a string if provided.' };
    }

    // tpaType is optional but if present, must be a valid TpaType value (excluding SYSTEM_DASHBOARD)
    if (config.tpaType !== undefined) {
      const validTpaTypes = [TpaType.BACKGROUND, TpaType.STANDARD];
      if (!validTpaTypes.includes(config.tpaType)) {
        console.log('Validation failed: tpaType is present but invalid');
        return { isValid: false, error: 'Optional field "tpaType" must be either "background" or "standard" if provided.' };
      }
    }

    // Validate each setting (but allow empty or missing settings array)
    if (config.settings && Array.isArray(config.settings)) {
      for (let index = 0; index < config.settings.length; index++) {
        const setting = config.settings[index];

        // Group settings just need a title
        if (setting.type === 'group') {
          if (typeof setting.title !== 'string') {
            console.log(`Validation failed: setting ${index} is a group but has invalid title`);
            return { isValid: false, error: `Setting ${index + 1}: Group type requires a "title" field with a string value.` };
          }
          continue;
        }

        // TITLE_VALUE settings just need label and value
        if (setting.type === 'titleValue') {
          if (typeof setting.label !== 'string') {
            console.log(`Validation failed: setting ${index} is titleValue but has invalid label`);
            return { isValid: false, error: `Setting ${index + 1}: TitleValue type requires a "label" field with a string value.` };
          }
          if (!('value' in setting)) {
            console.log(`Validation failed: setting ${index} is titleValue but has no value`);
            return { isValid: false, error: `Setting ${index + 1}: TitleValue type requires a "value" field.` };
          }
          continue;
        }

        // Regular settings need key and label and type
        if (typeof setting.key !== 'string' || typeof setting.label !== 'string' || typeof setting.type !== 'string') {
          console.log(`Validation failed: setting ${index} is missing key, label, or type`);
          return { isValid: false, error: `Setting ${index + 1}: Missing required fields "key", "label", or "type" (all must be strings).` };
        }

        // Type-specific validation
        switch (setting.type) {
          case 'toggle':
            if (setting.defaultValue !== undefined && typeof setting.defaultValue !== 'boolean') {
              console.log(`Validation failed: setting ${index} is toggle but defaultValue is not boolean`);
              return { isValid: false, error: `Setting ${index + 1}: Toggle type requires "defaultValue" to be a boolean if provided.` };
            }
            break;

          case 'text':
          case 'text_no_save_button':
            if (setting.defaultValue !== undefined && typeof setting.defaultValue !== 'string') {
              console.log(`Validation failed: setting ${index} is text but defaultValue is not string`);
              return { isValid: false, error: `Setting ${index + 1}: Text type requires "defaultValue" to be a string if provided.` };
            }
            break;

          case 'select':
          case 'select_with_search':
            if (!Array.isArray(setting.options)) {
              console.log(`Validation failed: setting ${index} is select but options is not an array`);
              return { isValid: false, error: `Setting ${index + 1}: Select type requires an "options" array.` };
            }
            for (let optIndex = 0; optIndex < setting.options.length; optIndex++) {
              const opt = setting.options[optIndex];
              if (typeof opt.label !== 'string' || !('value' in opt)) {
                console.log(`Validation failed: setting ${index} option ${optIndex} is invalid`);
                return { isValid: false, error: `Setting ${index + 1}, Option ${optIndex + 1}: Each option must have "label" (string) and "value" fields.` };
              }
            }
            break;

          case 'multiselect':
            if (!Array.isArray(setting.options)) {
              console.log(`Validation failed: setting ${index} is multiselect but options is not an array`);
              return { isValid: false, error: `Setting ${index + 1}: Multiselect type requires an "options" array.` };
            }
            for (let optIndex = 0; optIndex < setting.options.length; optIndex++) {
              const opt = setting.options[optIndex];
              if (typeof opt.label !== 'string' || !('value' in opt)) {
                console.log(`Validation failed: setting ${index} option ${optIndex} is invalid`);
                return { isValid: false, error: `Setting ${index + 1}, Option ${optIndex + 1}: Each option must have "label" (string) and "value" fields.` };
              }
            }
            if (setting.defaultValue !== undefined && !Array.isArray(setting.defaultValue)) {
              console.log(`Validation failed: setting ${index} is multiselect but defaultValue is not array`);
              return { isValid: false, error: `Setting ${index + 1}: Multiselect type requires "defaultValue" to be an array if provided.` };
            }
            break;

          case 'slider':
            if (typeof setting.defaultValue !== 'number' ||
                typeof setting.min !== 'number' ||
                typeof setting.max !== 'number' ||
                setting.min > setting.max) {
              console.log(`Validation failed: setting ${index} is slider but has invalid numeric properties`);
              return { isValid: false, error: `Setting ${index + 1}: Slider type requires "defaultValue", "min", and "max" to be numbers, with min ≤ max.` };
            }
            break;

          default:
            console.log(`Validation failed: setting ${index} has unknown type: ${setting.type}`);
            return { isValid: false, error: `Setting ${index + 1}: Unknown setting type "${setting.type}". Supported types: toggle, text, text_no_save_button, select, select_with_search, multiselect, slider, group, titleValue.` };
        }
      }
    }

    console.log('Validation passed');
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
      (fileInputRef.current as any).click();
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
    if (!file.name.toLowerCase().endsWith('.json')) {
      setImportError('Please select a JSON file.');
      return;
    }

    // Read file content
    const reader = new (window as any).FileReader();

    reader.onload = (e: any) => {
      try {
        const content = e.target.result as string;

        if (!content || content.trim() === '') {
          setImportError('The selected file is empty.');
          return;
        }

        let config;
        try {
          config = JSON.parse(content);
        } catch (parseError) {
          console.error('JSON parse error:', parseError);
          setImportError('Invalid JSON format. Please check the file content.');
          return;
        }

        // Log the parsed config for debugging
        console.log('Parsed config:', config);

        // Validate configuration structure
        const validation = validateTpaConfig(config);
        if (!validation.isValid) {
          console.error('Validation failed for config:', config);
          setImportError(validation.error || 'Invalid app_config.json format.');
          return;
        }

        // Store config data and open confirmation dialog
        setImportConfigData(config);
        setImportError(null);
        setIsImportDialogOpen(true);
      } catch (error) {
        console.error('Error processing file:', error);
        setImportError('Failed to process the file. Please try again.');
      }
    };

    reader.onerror = (error: any) => {
      console.error('FileReader error:', error);
      setImportError('Failed to read the file. Please try again.');
    };

    reader.readAsText(file);

    // Reset file input
    target.value = '';
  };

  /**
   * Handles confirming the import of configuration
   */
  const handleImportConfirm = () => {
    if (!importConfigData) {
      console.error('No import config data available');
      return;
    }

    setIsImporting(true);

    try {
      console.log('Importing configuration:', importConfigData);

      // Update form data with imported configuration
      setFormData(prev => {
        const newData = {
          ...prev,
          // Always update name and description if provided
          name: importConfigData.name || prev.name,
          description: importConfigData.description || prev.description,
          onboardingInstructions: importConfigData.onboardingInstructions || prev.onboardingInstructions,

          // Update URLs only if they are provided and not empty
          publicUrl: (importConfigData.publicUrl !== undefined && importConfigData.publicUrl.trim() !== '')
            ? importConfigData.publicUrl.trim()
            : prev.publicUrl,
          // Note: logoURL from import will be a Cloudflare Images URL or other hosted URL
          logoURL: (importConfigData.logoURL !== undefined && importConfigData.logoURL.trim() !== '')
            ? importConfigData.logoURL.trim()
            : prev.logoURL,
          // For webviewURL, treat empty strings as "not there at all" - only update if it has actual content
          webviewURL: (importConfigData.webviewURL !== undefined && typeof importConfigData.webviewURL === 'string' && importConfigData.webviewURL.trim() !== '')
            ? importConfigData.webviewURL.trim()
            : prev.webviewURL,

          // Update tpaType if provided, otherwise keep existing (defaults to BACKGROUND in form)
          tpaType: importConfigData.tpaType !== undefined
            ? importConfigData.tpaType
            : prev.tpaType,

          // Replace permissions if provided, otherwise keep existing
          permissions: importConfigData.permissions !== undefined
            ? importConfigData.permissions
            : prev.permissions || [],

          // Always replace settings and tools with imported data (can be empty arrays)
          settings: importConfigData.settings || [],
          tools: importConfigData.tools || []
        };

        console.log('Updated form data:', newData);
        return newData;
      });

      // Close dialog and show success message
      setIsImportDialogOpen(false);
      setImportConfigData(null);
      toast.success('Configuration imported successfully! Remember to save changes.');
    } catch (error) {
      console.error('Error importing configuration:', error);
      toast.error('Failed to import configuration. Please try again.');
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center mb-6">
          <Link to="/tpas" className="flex items-center text-sm text-gray-500 hover:text-gray-700">
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
                <CardDescription>
                  Update your app's configuration.
                </CardDescription>
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
                        size="sm"
                      >
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
                    <AlertDescription className="text-green-700">TPA updated successfully!</AlertDescription>
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
                  <p className="text-xs text-gray-500">
                    Package names cannot be changed after creation.
                  </p>
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
                    Provide a clear, concise description of your application's functionality.
                  </p>
                </div>

                {/* Onboarding Instructions Section */}
                <div className="space-y-2">
                  <Label htmlFor="onboardingInstructions">Onboarding Instructions</Label>
                  <Textarea
                    id="onboardingInstructions"
                    name="onboardingInstructions"
                    value={formData.onboardingInstructions || ''}
                    onChange={handleChange}
                    placeholder="Describe the onboarding steps for your app (optional)"
                    rows={3}
                    maxLength={2000}
                    style={{ maxHeight: '8em', overflowY: 'auto' }}
                  />
                  <p className="text-xs text-gray-500">
                    (Optional) Provide onboarding instructions that will be shown to users the first time they launch your app. Maximum 5 lines.
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
                    The base URL of your server where MentraOS will communicate with your app.
                    We'll automatically append "/webhook" to handle events when your app is activated.
                    HTTPS is required and will be added automatically if not specified.
                    Do not include a trailing slash - it will be automatically removed.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="logoURL">Logo URL</Label>
                  <ImageUpload
                    currentImageUrl={formData.logoURL}
                    onImageUploaded={(url) => {
                      setFormData(prev => ({
                        ...prev,
                        logoURL: url
                      }));
                    }}
                    packageName={formData.packageName}
                    disabled={isSaving}
                  />
                  {/* Note: The actual Cloudflare URL is stored in logoURL but not displayed to the user */}
                  <p className="text-xs text-gray-500">
                    Upload an image that will be used as your app's icon (recommended: 512x512 PNG).
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="webviewURL">Webview URL (Optional)</Label>
                  <Input
                    id="webviewURL"
                    name="webviewURL"
                    value={formData.webviewURL || ''}
                    onChange={handleChange}
                    onBlur={handleUrlBlur}
                    placeholder="yourserver.com/webview"
                  />
                  <p className="text-xs text-gray-500">
                    If your app has a companion mobile interface, provide the URL here.
                    HTTPS is required and will be added automatically if not specified.
                  </p>
                </div>

                {/* TPA Type Selection */}
                <div className="space-y-2 pb-5">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="tpaType">App Type</Label>
                    <TpaTypeTooltip />
                  </div>
                <p className="text-xs text-gray-500">
                  <br/>Background apps can run alongside other apps,
                  <br/>Only 1 foreground app can run at a time.
                  <br/>foreground apps yield the display to background apps when displaying content.
                </p>
                  <Select value={formData.tpaType} onValueChange={handleTpaTypeChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select app type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={TpaType.BACKGROUND}>
                        <div className="flex flex-col">
                          <span className="font-medium">Background App</span>
                          {/* <span className="text-xs text-gray-500">Multiple can run simultaneously</span> */}
                        </div>
                      </SelectItem>
                      <SelectItem value={TpaType.STANDARD}>
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
                    <PermissionsForm
                      permissions={formData.permissions || []}
                      onChange={handlePermissionsChange}
                    />
                  </div>

                {/* Settings Section */}
                <div className="border rounded-md p-4 mt-6">
                  <SettingsEditor
                    settings={formData.settings || []}
                    onChange={handleSettingsChange}
                  />
                </div>

                {/* Tools Section */}
                <div className="border rounded-md p-4 mt-6">
                  <ToolsEditor
                    tools={formData.tools || []}
                    onChange={handleToolsChange}
                  />
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
                      disabled={isLoadingShareLink}
                    >
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
                    Your API key is used to authenticate your app with MentraOS cloud services.
                    Keep it secure and never share it publicly.
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
                    App Status: {
                    formData.appStoreStatus === 'DEVELOPMENT' ? 'Development' :
                    formData.appStoreStatus === 'SUBMITTED' ? 'Submitted for Review' :
                    formData.appStoreStatus === 'REJECTED' ? 'Rejected' :
                    formData.appStoreStatus === 'PUBLISHED' ? 'Published' : 'Development'
                  }</h3>

                  <p className="text-sm text-gray-600 mb-4">
                    {formData.appStoreStatus === 'DEVELOPMENT'
                      ? 'Your app is currently in development. Publish it when ready to submit for review.'
                      : formData.appStoreStatus === 'SUBMITTED'
                      ? 'Your app has been submitted for review. Once approved, it will be published to the App Store.'
                      : formData.appStoreStatus === 'REJECTED'
                      ? 'Your app has been rejected. Please review the feedback and make the necessary changes before resubmitting.'
                      : 'Your app is published and available to all MentraOS users in the App Store.'}
                  </p>

                  {formData.appStoreStatus === 'REJECTED' && formData.reviewNotes && (
                    <div className="bg-red-50 border border-red-200 rounded-md p-3 mt-2 mb-4">
                      <h4 className="text-sm font-medium text-red-800 mb-1">Rejection Reason:</h4>
                      <p className="text-sm text-red-700">{formData.reviewNotes}</p>
                      {formData.reviewedAt && (
                        <p className="text-xs text-red-500 mt-2">
                          Reviewed on {new Date(formData.reviewedAt).toLocaleDateString()} by {formData.reviewedBy?.split('@')[0] || 'Admin'}
                        </p>
                      )}
                    </div>
                  )}

                  {(formData.appStoreStatus === 'DEVELOPMENT' || formData.appStoreStatus === 'REJECTED') && (
                    <div className="flex items-center justify-end">
                      <Button
                        onClick={handleOpenPublishDialog}
                        className="gap-2"
                        type="button"
                      >
                        <Upload className="h-4 w-4" />
                        {formData.appStoreStatus === 'REJECTED' ? 'Resubmit to App Store' : 'Publish to App Store'}
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
                    Import or export your app configuration (name, description, URLs, permissions, settings, and tools) as a app_config.json file
                  </p>

                  {/* Show import error if there is one and no dialog is open */}
                  {importError && !isImportDialogOpen && (
                    <Alert variant="destructive" className="mb-4">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>{importError}</AlertDescription>
                    </Alert>
                  )}

                  <div className="flex items-center justify-end">
                    <Button
                      onClick={handleImportClick}
                      variant="outline"
                      type="button"
                      className="mr-2"
                    >
                      <Download className="h-4 w-4 mr-2" />
                      Import app_config.json
                    </Button>
                    <Button
                      onClick={handleExportConfig}
                      variant="outline"
                      type="button"
                    >
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
                    style={{ display: 'none' }}
                  />
                </div>
              </CardContent>
              <CardFooter className="flex justify-between border-t p-6">
                <Button variant="outline" type="button" onClick={() => navigate('/tpas')}>
                  Back
                </Button>
                <Button type="submit" disabled={isSaving}>
                  {isSaving ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Saving...
                    </>
                  ) : "Save Changes"}
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
            tpa={formData}
            open={isApiKeyDialogOpen}
            onOpenChange={setIsApiKeyDialogOpen}
            apiKey={apiKey}
            orgId={currentOrg?.id}
          />

          <SharingDialog
            tpa={formData}
            open={isSharingDialogOpen}
            onOpenChange={setIsSharingDialogOpen}
            orgId={currentOrg?.id}
          />

          <PublishDialog
            tpa={formData}
            open={isPublishDialogOpen}
            onOpenChange={(open) => {
              setIsPublishDialogOpen(open);
            }}
            onPublishComplete={handlePublishComplete}
            orgId={currentOrg?.id}
          />

          {currentOrg && (
            <MoveOrgDialog
              tpa={formData}
              open={isMoveOrgDialogOpen}
              onOpenChange={setIsMoveOrgDialogOpen}
              eligibleOrgs={eligibleOrgs}
              currentOrgId={currentOrg.id}
              onMoveComplete={() => {
                // Handled by redirect in handleMoveToOrg
              }}
              onMove={handleMoveToOrg}
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
};

export default EditTPA;