# 🗑️ Delete Files Endpoint

## Overview

The `/api/delete-files` endpoint allows you to delete specific files from the camera storage by providing a list of filenames. This is an extension of the existing cleanup functionality, providing more granular control over file deletion.

## Endpoint Details

- **URL**: `/api/delete-files`
- **Method**: `POST`
- **Content-Type**: `application/json`

## Request Format

### Request Body

```json
{
  "files": ["filename1.jpg", "filename2.jpg", "filename3.jpg"]
}
```

### Parameters

- `files` (array, required): List of filenames to delete
  - Must be a non-empty array
  - Each filename should be a string
  - Empty filenames will be skipped and marked as failed

## Response Format

### Success Response

```json
{
  "status": "success",
  "data": {
    "message": "File deletion completed",
    "total_files": 3,
    "successful_deletions": 2,
    "failed_deletions": 1,
    "total_deleted_size": 2048576,
    "results": [
      {
        "file": "photo1.jpg",
        "success": true,
        "message": "File deleted successfully",
        "size": 1024288
      },
      {
        "file": "photo2.jpg",
        "success": false,
        "message": "File not found",
        "size": 0
      }
    ],
    "timestamp": 1640995200000
  }
}
```

### Error Responses

#### 400 Bad Request - Empty Files Array

```json
{
  "status": "error",
  "message": "Files array cannot be empty"
}
```

#### 400 Bad Request - Invalid JSON

```json
{
  "status": "error",
  "message": "Invalid JSON format: Unexpected end of input"
}
```

#### 405 Method Not Allowed

```json
{
  "status": "error",
  "message": "Only POST method is allowed"
}
```

#### 500 Internal Server Error

```json
{
  "status": "error",
  "message": "Unexpected error: [error details]"
}
```

## Usage Examples

### cURL Example

```bash
curl -X POST "http://localhost:8089/api/delete-files" \
  -H "Content-Type: application/json" \
  -d '{
    "files": ["photo1.jpg", "photo2.jpg", "photo3.jpg"]
  }'
```

### JavaScript Example

```javascript
const response = await fetch("/api/delete-files", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    files: ["photo1.jpg", "photo2.jpg", "photo3.jpg"],
  }),
})

const result = await response.json()
console.log("Deleted files:", result.data.successful_deletions)
console.log("Failed deletions:", result.data.failed_deletions)
```

### Python Example

```python
import requests
import json

url = "http://localhost:8089/api/delete-files"
data = {
    "files": ["photo1.jpg", "photo2.jpg", "photo3.jpg"]
}

response = requests.post(url, json=data)
result = response.json()

print(f"Successfully deleted: {result['data']['successful_deletions']} files")
print(f"Failed deletions: {result['data']['failed_deletions']} files")
```

## Security Features

- **File Validation**: Files are validated through the FileManager's security system
- **Package Isolation**: Files are restricted to the camera package directory
- **Operation Logging**: All deletion operations are logged for audit purposes
- **Error Handling**: Comprehensive error handling prevents system crashes

## Performance Considerations

- **Batch Processing**: Multiple files are processed in a single request
- **Size Tracking**: Total deleted size is calculated and reported
- **Individual Results**: Each file deletion result is tracked separately
- **Timeout Protection**: Built-in timeout mechanisms prevent hanging operations

## Testing

Use the provided test script to verify the endpoint functionality:

```bash
./test_delete_files.sh
```

This script tests various scenarios including:

- Single file deletion
- Multiple file deletion
- Empty array handling
- Invalid JSON handling
- Method validation

## Integration with Existing System

This endpoint integrates seamlessly with the existing file management system:

- Uses the same `FileManager.deleteFile()` method as other operations
- Follows the same security validation patterns
- Integrates with the operation logging system
- Maintains consistency with other API endpoints

## Error Handling

The endpoint handles various error scenarios:

1. **Missing Files**: Files that don't exist are marked as failed but don't stop the process
2. **Permission Errors**: Files that can't be deleted due to permissions are reported
3. **Invalid Input**: Malformed JSON or empty arrays return appropriate error messages
4. **System Errors**: Unexpected errors are caught and reported with details

## Monitoring and Logging

All operations are logged with appropriate levels:

- **Debug**: Individual file deletion attempts
- **Info**: Summary of deletion operations
- **Warn**: Failed deletions and validation issues
- **Error**: System errors and exceptions

The logs include:

- File names being processed
- Success/failure status for each file
- File sizes for successful deletions
- Error messages for failed operations
- Total operation statistics
