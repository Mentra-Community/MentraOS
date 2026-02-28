# Gallery Delta Sync Implementation

This document describes the delta sync functionality implemented in the ASG Gallery component.

## Overview

The delta sync feature allows the mobile app to efficiently synchronize with the ASG Camera Server by only downloading files that have changed since the last sync operation. This reduces bandwidth usage and improves performance.

## Components

### 1. SyncButton Component (`SyncButton.tsx`)

A reusable button component that displays:

- Sync button with loading state
- Last sync time
- Sync statistics (new/deleted files, total size)

### 2. GalleryScreen Integration

The main gallery screen now includes:

- Sync state management
- Delta sync functionality
- Error handling for sync operations
- Visual feedback for sync status

### 3. API Client Extensions (`asgCameraApi.ts`)

New methods added to the API client:

- `syncGallery()` - Perform delta sync
- `batchSyncFiles()` - Batch download multiple files
- `getSyncStatus()` - Get server sync status and recommendations
- `generateClientId()` - Generate unique client identifiers

## Sync Flow

1. **Initial Sync**: When sync is first triggered, all files are returned
2. **Delta Sync**: Subsequent syncs only return files modified since the last sync timestamp
3. **Client Tracking**: Each client has a unique ID for tracking sync state
4. **Error Handling**: Failed syncs are handled gracefully with user feedback

## API Endpoints Used

### `/api/sync`

- **Method**: GET
- **Parameters**:
  - `client_id` (required): Unique client identifier
  - `last_sync` (optional): Timestamp of last sync
  - `include_thumbnails` (optional): Include video thumbnails
- **Response**: List of changed files and sync metadata

### `/api/sync-batch`

- **Method**: POST
- **Body**: JSON with file list and client ID
- **Response**: Batch download results with base64 encoded files

### `/api/sync-status`

- **Method**: GET
- **Response**: Server status, file counts, and sync recommendations

## Usage

### Basic Sync

```typescript
const handleSync = async () => {
  const syncResponse = await asgCameraApi.syncGallery(
    clientId,
    lastSyncTime,
    true, // include thumbnails
  )

  // Update local photos with new data
  setPhotos(prevPhotos => {
    const existingNames = new Set(prevPhotos.map(p => p.name))
    const newPhotos = syncResponse.changed_files.filter(p => !existingNames.has(p.name))
    return [...prevPhotos, ...newPhotos]
  })
}
```

### Sync with UI Feedback

```typescript
<SyncButton
  onPress={handleSync}
  isSyncing={syncState.isSyncing}
  lastSyncTime={syncState.lastSyncTime}
  syncStats={syncState.lastSyncStats}
  disabled={isLoading}
/>
```

## Features

### Delta Sync

- Only downloads changed files since last sync
- Tracks sync timestamps per client
- Handles both new and deleted files

### Batch Operations

- Efficient batch downloading of multiple files
- Base64 encoding for JSON transmission
- Thumbnail support for video files

### Error Handling

- Network error recovery
- Server error handling
- User-friendly error messages

### Performance Optimizations

- Rate limiting for API requests
- Caching of sync responses
- Efficient file merging logic

## Testing

Use the `SyncTest` component to verify sync functionality:

```typescript
import {SyncTest} from "./SyncTest"

// Add to your screen for testing
<SyncTest />
```

## Configuration

### Sync Recommendations

The server provides recommended settings:

- **Sync Interval**: 30 seconds (configurable)
- **Batch Size**: 10 files per batch
- **Thumbnails**: Enabled by default
- **Compression**: Disabled (uses base64)

### Client ID Generation

Each client gets a unique ID:

- Format: `mobile_{timestamp}_{random}`
- Ensures proper sync state tracking
- Prevents conflicts between multiple clients

## Future Enhancements

1. **Automatic Sync**: Background sync at regular intervals
2. **Conflict Resolution**: Handle file conflicts between clients
3. **Offline Support**: Queue sync operations when offline
4. **Progress Tracking**: Real-time sync progress indicators
5. # **Selective Sync**: Allow users to choose which files to sync

# ASG Gallery Component

## Overview

The ASG Gallery component provides a comprehensive photo and video management interface for AugmentOS Smart Glasses. It features dual-tab functionality to manage both server-side and locally downloaded media files.

## Features

### Dual Tab Interface

- **On Server Tab**: Displays photos and videos currently stored on the ASG glasses
- **Downloaded Tab**: Shows files that have been synced and stored locally on the mobile device

### Sync Functionality

- **Delta Sync**: Downloads only new/changed files since last sync
- **Batch Processing**: Downloads files in small batches for reliability
- **Automatic Cleanup**: Deletes files from server after successful local download
- **Error Handling**: Graceful handling of network issues and failed downloads
- **Progress Tracking**: Real-time progress updates during sync operations

### Photo Management

- **Take Picture**: Capture new photos directly from the glasses
- **View Photos**: Full-screen photo viewing with modal interface
- **Delete Photos**: Remove photos from server or local storage
- **Video Support**: Display video files with play indicator

## Technical Implementation

### API Integration

The component integrates with the ASG Camera Server API through `asgCameraApi.ts`:

- `getGalleryPhotos()`: Fetch photos from server
- `syncWithServer()`: Get changed files since last sync
- `batchSyncFiles()`: Download files in batches
- `deleteFilesFromServer()`: Remove files from server
- `takePicture()`: Capture new photo

### Local Storage

Uses `localStorageService.ts` for managing downloaded files:

- **File Storage**: Base64 encoded files stored in AsyncStorage
- **Sync State**: Tracks last sync time and client ID
- **File Conversion**: Utilities for converting between PhotoInfo and DownloadedFile formats
- **Storage Statistics**: Track total files and storage usage

### State Management

- **Server Photos**: Photos currently on the ASG glasses
- **Downloaded Photos**: Locally stored photos
- **Sync Progress**: Real-time sync operation status
- **Error Handling**: User-friendly error messages
- **Loading States**: Visual feedback during operations

## Usage

### Basic Gallery View

```tsx
<GalleryScreen deviceModel="ASG Glasses" />
```

### Sync Process

1. User taps "Sync" button
2. System checks for new/changed files since last sync
3. Downloads files in batches of 3
4. Saves files to local storage
5. Deletes files from server after successful download
6. Updates sync state and refreshes photo grids

### File Operations

- **Long Press**: Delete photo (server or local)
- **Tap**: View photo in full screen
- **Take Picture**: Capture new photo (server tab only)

## Error Handling

The component handles various error scenarios:

- **Network Issues**: Displays connection status and retry options
- **Sync Failures**: Partial sync with failed file reporting
- **Storage Issues**: Graceful degradation when storage is full
- **Server Errors**: User-friendly error messages with troubleshooting tips

## Performance Considerations

- **Batch Downloads**: Files downloaded in small batches to avoid overwhelming server
- **Rate Limiting**: API requests are rate-limited to prevent server overload
- **Memory Management**: Large files are processed efficiently with base64 encoding
- **Storage Cleanup**: Automatic cleanup of old sync state data

## Future Enhancements

- **Background Sync**: Automatic sync when app is in background
- **Cloud Storage**: Integration with cloud storage services
- **Photo Editing**: Basic photo editing capabilities
- **Sharing**: Share photos directly from the gallery
- **Filters**: Filter photos by date, type, or other criteria
