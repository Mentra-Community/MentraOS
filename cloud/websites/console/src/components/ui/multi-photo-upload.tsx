import * as React from "react";
import { X, Upload, Image as ImageIcon, ZoomIn, Loader2, Info } from "lucide-react";
import { cn } from "@/libs/utils";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@mentra/shared";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";

export type PhotoOrientation = "landscape" | "portrait";

// Max file size for preview images (5MB)
const MAX_FILE_SIZE = 5 * 1024 * 1024;

export interface PhotoUploadItem {
  id: string;
  file?: File; // Only present during initial selection, before upload
  url: string; // Cloud storage delivery URL (populated after upload)
  imageId?: string; // Cloud storage image ID (for deletion)
  preview: string; // Blob URL for local files, or url for remote images
  orientation?: PhotoOrientation;
  uploading?: boolean; // Track upload state
  error?: string; // Track upload errors
}

interface MultiPhotoUploadProps {
  photos: PhotoUploadItem[];
  onChange: (photos: PhotoUploadItem[]) => void;
  packageName?: string; // App package name for metadata
  maxPhotos?: number;
  disabled?: boolean;
  className?: string;
}

export function MultiPhotoUpload({
  photos,
  onChange,
  packageName,
  maxPhotos = 8,
  disabled = false,
  className,
}: MultiPhotoUploadProps) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = React.useState(false);
  const [selectedPhoto, setSelectedPhoto] = React.useState<PhotoUploadItem | null>(null);
  const [showOrientationDialog, setShowOrientationDialog] = React.useState(false);
  const [selectedOrientation, setSelectedOrientation] = React.useState<PhotoOrientation | null>(null);
  const [draggedIndex, setDraggedIndex] = React.useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = React.useState<number | null>(null);
  const [photoToDelete, setPhotoToDelete] = React.useState<string | null>(null);

  const handleFiles = (files: FileList | null, orientation: PhotoOrientation) => {
    if (!files || disabled) return;

    if (files.length === 0) return;

    const remainingSlots = maxPhotos - photos.length;
    const filesArray = Array.from(files);

    // Validate file sizes before processing
    const validFiles: File[] = [];
    const errors: string[] = [];

    for (const file of filesArray) {
      if (file.size > MAX_FILE_SIZE) {
        const sizeMB = (file.size / 1024 / 1024).toFixed(1);
        errors.push(`${file.name}: ${sizeMB}MB (max 5MB)`);
      } else {
        validFiles.push(file);
      }
    }

    // Show errors if any files were rejected
    if (errors.length > 0) {
      toast.error(
        `${errors.length} ${errors.length === 1 ? "file" : "files"} too large:\n${errors.join("\n")}\n\nTip: Compress or resize images before uploading.`,
        { duration: 5000 },
      );
    }

    // Continue with valid files only
    const filesToAdd = validFiles.slice(0, remainingSlots);

    if (filesToAdd.length === 0) return;

    // Create photo items with blob URLs for preview - will upload on save
    const newPhotos: PhotoUploadItem[] = filesToAdd.map((file) => ({
      id: `${Date.now()}-${Math.random()}`,
      file,
      url: "",
      preview: URL.createObjectURL(file),
      orientation,
      uploading: false,
    }));

    // Add photos to state immediately to show preview
    const allPhotos = [...photos, ...newPhotos];
    onChange(allPhotos);

    // Show success message if files were added
    if (filesToAdd.length > 0) {
      toast.success(`${filesToAdd.length} ${filesToAdd.length === 1 ? "image" : "images"} added`);
    }
  };

  const openOrientationDialog = () => {
    if (!disabled) {
      setShowOrientationDialog(true);
    }
  };

  const selectOrientation = (orientation: PhotoOrientation) => {
    setSelectedOrientation(orientation);
    setShowOrientationDialog(false);
    // Open file picker after orientation is selected
    setTimeout(() => {
      fileInputRef.current?.click();
    }, 100);
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;

    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (disabled) return;

    // For drag and drop, show orientation dialog first
    setShowOrientationDialog(true);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (selectedOrientation) {
      handleFiles(e.target.files, selectedOrientation);
      setSelectedOrientation(null);
    }
    // Reset input value to allow selecting the same file again
    e.target.value = "";
  };

  const confirmRemovePhoto = (id: string) => {
    setPhotoToDelete(id);
  };

  const removePhoto = () => {
    if (!photoToDelete) return;

    const photoToRemove = photos.find((p) => p.id === photoToDelete);
    if (!photoToRemove) return;

    // Just remove from UI state - actual deletion will happen on form save
    // Revoke blob URL if it exists
    if (photoToRemove.preview && photoToRemove.file) {
      URL.revokeObjectURL(photoToRemove.preview);
    }

    // Remove from state
    onChange(photos.filter((p) => p.id !== photoToDelete));
    setPhotoToDelete(null);

    toast.info("Image will be removed when you save changes");
  };

  const handleDragStart = (index: number) => {
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleDragEnd = () => {
    if (draggedIndex !== null && dragOverIndex !== null && draggedIndex !== dragOverIndex) {
      const newPhotos = [...photos];
      const [draggedPhoto] = newPhotos.splice(draggedIndex, 1);
      newPhotos.splice(dragOverIndex, 0, draggedPhoto);
      onChange(newPhotos);

      // Remind user to save changes after reordering
      toast.info("Image order changed. Remember to save your changes!");
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  React.useEffect(() => {
    return () => {
      photos.forEach((photo) => {
        if (photo.preview && photo.file) {
          URL.revokeObjectURL(photo.preview);
        }
      });
    };
  }, []);

  const canAddMore = photos.length < maxPhotos;

  return (
    <div className={cn("space-y-4 pt-[10px]", className)}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/jpg,image/gif,image/webp"
        multiple
        onChange={handleFileInput}
        className="hidden"
        disabled={disabled}
      />

      {/* Image Guidelines */}
      <div className="rounded-lg border bg-muted/50 p-4">
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 text-muted-foreground mt-0.5 flex-shrink-0" />
          <div className="space-y-2 text-sm">
            <p className="font-medium">Preview Image Guidelines</p>
            <ul className="space-y-1 text-muted-foreground">
              <li>
                • <strong>File size:</strong> Max 5MB per image
              </li>
              <li>
                • <strong>Recommended dimensions:</strong> 1920x1080px (landscape) or 1080x1920px (portrait)
              </li>
              <li>
                • <strong>Formats:</strong> PNG, JPEG, GIF, or WebP
              </li>
              <li>
                • <strong>Best practices:</strong> Use clear screenshots that showcase your app's features
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* Horizontal Photo Carousel */}
      <div className="flex gap-4 overflow-x-auto pb-4 snap-x snap-mandatory pt-4">
        {photos.map((photo, index) => {
          const isPortrait = photo.orientation === "portrait";
          const isDragging = draggedIndex === index;
          const isDragOver = dragOverIndex === index;

          return (
            <div
              key={photo.id}
              draggable={!disabled}
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragEnd={handleDragEnd}
              className={cn(
                "relative group flex-shrink-0 rounded-lg border bg-muted cursor-move snap-start transition-all",
                "h-64", // Fixed height for consistency
                isPortrait ? "w-36" : "w-[28rem]", // Width based on orientation to maintain aspect ratio
                isDragging && "opacity-50 scale-95",
                isDragOver && "ring-2 ring-primary",
                disabled && "cursor-not-allowed",
                photo.uploading && "opacity-75",
                photo.error && "border-destructive border-2",
              )}
              onClick={() => !photo.uploading && setSelectedPhoto(photo)}>
              <div className="w-full h-full rounded-lg overflow-hidden">
                <img
                  src={photo.preview || photo.url}
                  alt="Preview"
                  className="w-full h-full object-cover transition-transform group-hover:scale-105"
                />
              </div>

              {/* Upload Progress Overlay */}
              {photo.uploading && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="w-8 h-8 text-white animate-spin" />
                    <span className="text-white text-sm">Uploading...</span>
                  </div>
                </div>
              )}

              {/* Error Overlay */}
              {photo.error && (
                <div className="absolute inset-0 bg-destructive/20 flex items-center justify-center">
                  <div className="bg-destructive text-destructive-foreground px-3 py-1 rounded text-sm">
                    {photo.error}
                  </div>
                </div>
              )}

              {/* Order Badge */}
              <div className="absolute top-2 left-2 flex items-center gap-2">
                <div className="px-2 py-1 rounded bg-black/60 text-white text-xs font-medium">#{index + 1}</div>
                {photo.orientation && (
                  <div className="px-2 py-1 rounded bg-black/60 text-white text-xs font-medium">
                    {isPortrait ? "9:16" : "16:9"}
                  </div>
                )}
              </div>

              {/* Hover overlay */}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                <ZoomIn className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  confirmRemovePhoto(photo.id);
                }}
                disabled={disabled || photo.uploading}
                className="absolute top-2 right-2 p-1 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80 disabled:opacity-50 z-10"
                aria-label="Remove photo">
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}

        {/* Add Photo Card */}
        {canAddMore && (
          <button
            type="button"
            onClick={openOrientationDialog}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            disabled={disabled}
            className={cn(
              "shrink-0 h-64 w-48 rounded-lg border-2 border-dashed flex flex-col items-center justify-center gap-2 transition-colors hover:border-primary/50 hover:bg-accent/50 snap-start",
              dragActive && "border-primary bg-accent",
              disabled && "opacity-50 cursor-not-allowed",
            )}>
            {dragActive ? (
              <ImageIcon className="w-8 h-8 text-muted-foreground" />
            ) : (
              <Upload className="w-8 h-8 text-muted-foreground" />
            )}
            <span className="text-sm text-muted-foreground text-center px-2">
              {dragActive ? "Drop here" : "Add photo"}
            </span>
          </button>
        )}
      </div>

      {/* Scroll Hint */}
      {photos.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          ← Scroll horizontally to view all photos • Drag to reorder →
        </p>
      )}

      {/* Info Text */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <p>
          {photos.length} / {maxPhotos} photos
        </p>
        {canAddMore && (
          <Button type="button" size="sm" onClick={openOrientationDialog} disabled={disabled}>
            <Upload className="w-4 h-4" />
            Upload Photos
          </Button>
        )}
      </div>

      {/* Orientation Selection Dialog */}
      <Dialog open={showOrientationDialog} onOpenChange={setShowOrientationDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Select Image Orientation</DialogTitle>
            <DialogDescription>Choose the orientation for your images before selecting them.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-4">
            <button
              type="button"
              onClick={() => selectOrientation("landscape")}
              className="flex flex-col items-center gap-3 p-6 rounded-lg border-2 hover:border-primary hover:bg-accent transition-colors">
              <div className="w-24 h-16 border-2 border-muted-foreground rounded flex items-center justify-center">
                <span className="text-xs text-muted-foreground">16:9</span>
              </div>
              <span className="font-medium">Landscape</span>
            </button>
            <button
              type="button"
              onClick={() => selectOrientation("portrait")}
              className="flex flex-col items-center gap-3 p-6 rounded-lg border-2 hover:border-primary hover:bg-accent transition-colors">
              <div className="w-16 h-24 border-2 border-muted-foreground rounded flex items-center justify-center">
                <span className="text-xs text-muted-foreground">195:422</span>
              </div>
              <span className="font-medium">Portrait</span>
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Expanded Photo Modal */}
      <Dialog open={selectedPhoto !== null} onOpenChange={(open) => !open && setSelectedPhoto(null)}>
        <DialogContent
          className={cn(
            "p-0 bg-black/95 border-none",
            selectedPhoto?.orientation === "portrait" ? "max-w-2xl" : "max-w-5xl",
          )}>
          <div
            className={cn(
              "relative w-full",
              selectedPhoto?.orientation === "portrait" ? "aspect-[9/16]" : "aspect-video",
            )}>
            {selectedPhoto && (
              <>
                <img
                  src={selectedPhoto.preview || selectedPhoto.url}
                  alt="Expanded preview"
                  className="w-full h-full object-contain"
                />
                <button
                  type="button"
                  onClick={() => setSelectedPhoto(null)}
                  className="absolute top-4 right-4 p-2 rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors"
                  aria-label="Close preview">
                  <X className="w-5 h-5" />
                </button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={photoToDelete !== null} onOpenChange={(open) => !open && setPhotoToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Image?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this image? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={removePhoto}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 text-white">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
