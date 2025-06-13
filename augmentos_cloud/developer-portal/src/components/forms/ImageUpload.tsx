import React, { useState, useRef } from 'react';
import { Upload, X, AlertCircle, Loader2, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import api from '@/services/api.service';
import { toast } from 'sonner';

interface ImageUploadProps {
  /**
   * Current image URL (if any)
   */
  currentImageUrl?: string;
  /**
   * Callback when image is successfully uploaded
   * @param url - The new image URL
   */
  onImageUploaded: (url: string) => void;
  /**
   * Package name of the app (for metadata)
   */
  packageName?: string;
  /**
   * Whether the field is disabled
   */
  disabled?: boolean;
  /**
   * Whether this field has validation errors
   */
  hasError?: boolean;
  /**
   * Error message to display
   */
  errorMessage?: string;
}

/**
 * Component for uploading and managing app icon images
 * Handles upload to Cloudflare Images and shows preview
 */
const ImageUpload: React.FC<ImageUploadProps> = ({
  currentImageUrl,
  onImageUploaded,
  packageName,
  disabled = false,
  hasError = false,
  errorMessage
}) => {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(currentImageUrl || null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Update preview when currentImageUrl changes
  React.useEffect(() => {
    if (currentImageUrl) {
      setPreviewUrl(currentImageUrl);
    }
  }, [currentImageUrl]);

  // Extract image ID from Cloudflare URL if present
  const getImageIdFromUrl = (url: string): string | null => {
    // Cloudflare Images URLs typically have format:
    // https://imagedelivery.net/[account-hash]/[image-id]/[variant]
    const match = url.match(/imagedelivery\.net\/[^\/]+\/([^\/]+)/);
    return match ? match[1] : null;
  };

  /**
   * Validates the selected file
   */
  const validateFile = (file: File): string | null => {
    // Check file type
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      return 'Please select a valid image file (PNG, JPEG, GIF, or WebP)';
    }

    // Check file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      return 'Image size must be less than 10MB';
    }

    return null;
  };

  /**
   * Handles file selection and upload
   */
  const handleFileSelect = async (file: File) => {
    // Reset errors
    setUploadError(null);

    // Validate file
    const validationError = validateFile(file);
    if (validationError) {
      setUploadError(validationError);
      return;
    }

    // Show preview immediately
    const reader = new FileReader();
    reader.onload = (e) => {
      setPreviewUrl(e.target?.result as string);
    };
    reader.readAsDataURL(file);

    // Upload to Cloudflare
    setIsUploading(true);
    try {
      let result;

      // Check if we're replacing an existing image
      const existingImageId = currentImageUrl ? getImageIdFromUrl(currentImageUrl) : null;

      if (existingImageId) {
        // Replace existing image
        result = await api.images.replace(existingImageId, file);
      } else {
        // Upload new image
        result = await api.images.upload(file, { appPackageName: packageName });
      }

      // Update the form with the new URL
      onImageUploaded(result.url);
      setPreviewUrl(result.url);

      toast.success('Image uploaded successfully');
    } catch (error) {
      console.error('Error uploading image:', error);
      setUploadError('Failed to upload image. Please try again.');
      // Revert preview on error
      setPreviewUrl(currentImageUrl || null);
    } finally {
      setIsUploading(false);
    }
  };

  /**
   * Handles file input change
   */
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  /**
   * Handles drag and drop
   */
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  /**
   * Removes the current image
   */
  const handleRemoveImage = () => {
    setPreviewUrl(null);
    onImageUploaded('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-3">
      {/* Error messages */}
      {(uploadError || errorMessage) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{uploadError || errorMessage}</AlertDescription>
        </Alert>
      )}

      {/* Image preview or upload area */}
      {previewUrl ? (
        <div className="relative">
          <div className="relative w-32 h-32 rounded-lg overflow-hidden border-2 border-gray-200 bg-gray-50">
            <img
              src={previewUrl}
              alt="App icon"
              className="w-full h-full object-cover"
              onError={() => {
                setPreviewUrl(null);
                setUploadError('Failed to load image');
              }}
            />
            {isUploading && (
              <div className="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center">
                <Loader2 className="h-6 w-6 text-white animate-spin" />
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || isUploading}
            >
              Replace
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRemoveImage}
              disabled={disabled || isUploading}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : (
        <div
          className={`
            relative border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors
            ${hasError ? 'border-red-300' : 'border-gray-300'}
            ${isDragging ? 'border-blue-400 bg-blue-50' : 'hover:border-gray-400'}
            ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
          `}
          onClick={() => !disabled && fileInputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className="flex flex-col items-center">
            {isUploading ? (
              <Loader2 className="h-8 w-8 text-gray-400 mb-2 animate-spin" />
            ) : (
              <ImageIcon className="h-8 w-8 text-gray-400 mb-2" />
            )}
            <p className="text-sm text-gray-600">
              {isUploading ? 'Uploading...' : 'Click to upload or drag and drop'}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              PNG, JPEG, GIF or WebP (max 10MB)
            </p>
            <p className="text-xs text-gray-500">
              Recommended: 512x512px
            </p>
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/gif,image/webp"
        onChange={handleFileInputChange}
        disabled={disabled || isUploading}
        className="hidden"
      />
    </div>
  );
};

export default ImageUpload;