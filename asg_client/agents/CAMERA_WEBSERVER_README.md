# 📸 AugmentOS Camera Web Server

The **CameraWebServer** is an enhanced HTTP server that runs on Android smart glasses, providing a modern web interface for capturing, viewing, and downloading photos directly over the local network.

## 🚀 Features

### ✨ Enhanced Functionality

- **📱 Modern Web Interface**: Beautiful, responsive UI optimized for mobile devices
- **🖼️ Photo Gallery**: Browse all captured photos with metadata
- **⬇️ Direct Download**: Download photos directly to your device
- **📸 Remote Capture**: Trigger photo capture from any device on the network
- **🔄 Real-time Updates**: Auto-refresh gallery and live status updates
- **🔒 Security**: Rate limiting and input validation
- **⚡ Performance**: File caching and optimized delivery

### 🌐 API Endpoints

| Endpoint                      | Method | Description                   |
| ----------------------------- | ------ | ----------------------------- |
| `/`                           | GET    | Main web interface            |
| `/api/take-picture`           | POST   | Trigger photo capture         |
| `/api/latest-photo`           | GET    | Get the most recent photo     |
| `/api/gallery`                | GET    | List all photos with metadata |
| `/api/photo?file=filename`    | GET    | Get a specific photo          |
| `/api/download?file=filename` | GET    | Download a photo              |
| `/api/status`                 | GET    | Server status information     |
| `/api/health`                 | GET    | Health check endpoint         |

## 🔧 Setup & Usage

### 1. **Automatic Integration**

The CameraWebServer is automatically integrated into the ASG client service and starts when the service initializes.

### 2. **Network Requirements**

- Both smart glasses and mobile device must be on the same WiFi network
- No internet connection required - works entirely on local network

### 3. **Accessing the Web Interface**

#### From Mobile Device:

1. Connect your mobile device to the same WiFi network as the smart glasses
2. Open a web browser
3. Navigate to the server URL displayed in the ASG client logs:
   ```
   http://[GLASSES_IP]:8089
   ```
4. The modern web interface will load automatically

#### Finding the Glasses IP Address:

- Check the ASG client service logs for the server URL
- Look for: `🌐 Web server URL: http://192.168.x.x:8089`
- Or use network scanning tools to find devices on port 8089

### 4. **Using the Interface**

#### 📷 Taking Photos:

- Click the "Take Photo" button in the camera panel
- The photo will be captured and automatically added to the gallery
- Real-time status updates show capture progress

#### 🖼️ Viewing Photos:

- All photos are displayed in a responsive grid layout
- Click any photo to view it in full-screen modal
- Photos show metadata (size, date, filename)

#### ⬇️ Downloading Photos:

- Click the "Download" button on any photo card
- Photos will download directly to your device
- Files maintain original quality and metadata

## 🛠️ Technical Details

### Architecture

```
┌─────────────────┐    HTTP/JSON    ┌─────────────────┐
│   Mobile App    │ ◄──────────────► │  CameraWebServer │
│   (Browser)     │                 │   (Port 8089)   │
└─────────────────┘                 └─────────────────┘
                                              │
                                              ▼
                                    ┌─────────────────┐
                                    │  MediaCapture   │
                                    │    Service      │
                                    └─────────────────┘
                                              │
                                              ▼
                                    ┌─────────────────┐
                                    │   CameraNeo     │
                                    │   (Camera)      │
                                    └─────────────────┘
```

### Security Features

- **Rate Limiting**: 100 requests per minute per IP
- **Input Validation**: Prevents directory traversal attacks
- **File Size Limits**: 50MB maximum file size
- **CORS Support**: Cross-origin requests for web apps

### Performance Optimizations

- **File Caching**: Frequently accessed files cached in memory
- **Compression**: Efficient file delivery
- **Connection Pooling**: Reuses HTTP connections
- **Async Processing**: Non-blocking I/O operations

## 🔧 Configuration

### Enabling/Disabling the Web Server

```java
// In ASG client service
AsgClientService service = getService();
service.setWebServerEnabled(true);  // Enable
service.setWebServerEnabled(false); // Disable
```

### Custom Port Configuration

```java
// Create with custom port
CameraWebServer server = new CameraWebServer(context, 9090);
```

### Photo Directory

The server automatically detects the photo directory from CameraNeo or uses the default:

```
/storage/emulated/0/Android/data/com.mentra.asg_client/files/Photos/
```

## 📱 Mobile App Integration

### React Native Example

```javascript
// Connect to the camera web server
const connectToGlasses = async (glassesIP) => {
  const serverUrl = `http://${glassesIP}:8089`

  try {
    // Get gallery
    const response = await fetch(`${serverUrl}/api/gallery`)
    const gallery = await response.json()

    // Take a photo
    const photoResponse = await fetch(`${serverUrl}/api/take-picture`, {
      method: "POST",
    })

    // Download a photo
    const downloadUrl = `${serverUrl}/api/download?file=photo.jpg`
    // Use react-native-fs or similar to download
  } catch (error) {
    console.error("Failed to connect to glasses:", error)
  }
}
```

### Native Android Example

```java
// Connect to the camera web server
public void connectToGlasses(String glassesIP) {
    String serverUrl = "http://" + glassesIP + ":8089";

    // Get gallery
    String galleryUrl = serverUrl + "/api/gallery";
    // Use OkHttp or similar to make requests

    // Take a photo
    String photoUrl = serverUrl + "/api/take-picture";
    // POST request to trigger capture

    // Download a photo
    String downloadUrl = serverUrl + "/api/download?file=photo.jpg";
    // Download file to local storage
}
```

## 🐛 Troubleshooting

### Common Issues

#### 1. **Can't Access Web Interface**

- **Check Network**: Ensure both devices are on same WiFi
- **Check IP**: Verify the glasses IP address in logs
- **Check Port**: Ensure port 8089 is not blocked by firewall
- **Check Service**: Verify ASG client service is running

#### 2. **Photos Not Loading**

- **Check Permissions**: Ensure camera and storage permissions
- **Check Directory**: Verify photo directory exists and is accessible
- **Check Logs**: Look for file access errors in logs

#### 3. **Slow Performance**

- **Check Network**: Ensure good WiFi signal strength
- **Check Cache**: Server caches files for better performance
- **Check File Size**: Large photos may take longer to load

### Debug Logs

Enable debug logging to see detailed server activity:

```bash
adb logcat | grep CameraWebServer
```

## 🔄 Updates & Maintenance

### Recent Improvements

- ✅ Enhanced UI with modern design
- ✅ Gallery browsing functionality
- ✅ Direct download capability
- ✅ Rate limiting and security
- ✅ Performance optimizations
- ✅ Mobile-responsive design
- ✅ Real-time status updates

### Future Enhancements

- 🔄 Video streaming support
- 🔄 Authentication system
- 🔄 WebSocket real-time updates
- 🔄 Photo editing capabilities
- 🔄 Cloud sync integration

## 📄 License

This component is part of the AugmentOS platform and follows the same licensing terms.

---

**Need Help?** Check the logs for detailed error messages or contact the development team.
