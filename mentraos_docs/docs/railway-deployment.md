---
sidebar_position: 2
---

# Deploy to Railway

This guide will walk you through deploying your MentraOS app to Railway, a cloud hosting platform that makes deployment simple and reliable. Instead of running your app locally with ngrok, you'll have a production-ready hosted solution.

## Why Use Railway?

**Benefits of Railway hosting:**
- **Always Online**: Your app runs 24/7 without needing your computer
- **Automatic Deployments**: Push code changes to GitHub and Railway deploys automatically
- **Better Performance**: Dedicated cloud infrastructure with better uptime than local development
- **Professional URLs**: Clean, professional domain names instead of random ngrok URLs
- **Scalability**: Easily handle more users and higher traffic
- **Environment Management**: Separate development and production environments
- **No Local Dependencies**: No need to keep ngrok running or manage local tunnels

## Prerequisites

Make sure you have:

- **GitHub Account**: For code repository hosting
- **Railway Account**: Free account at [railway.com](https://railway.com)
- **MentraOS Account**: For the developer console at [console.mentra.glass](https://console.mentra.glass)
- **Basic Git Knowledge**: For pushing code changes

## Part 1: Set Up Your Repository

### 1. Create Your App Repository

Create a new repository from the MentraOS example app template:

**Option A: Using GitHub Web Interface**
1. Go to the [MentraOS Cloud Example App repository](https://github.com/Mentra-Community/MentraOS-Extended-Example-App)
2. Click the green **"Use this template"** dropdown in the upper right
3. Select **"Create a new repository"**
4. Choose a repository name (e.g., `my-mentraos-app`)
5. Set visibility to Public or Private
6. Click **"Create repository"**

![Create repo from template](https://github.com/user-attachments/assets/c10e14e8-2dc5-4dfa-adac-dd334c1b73a5)

**Option B: Using GitHub CLI**
```bash
gh repo create --template Mentra-Community/MentraOS-Extended-Example-App my-mentraos-app
```

### 2. Clone Your Repository

Clone your new repository locally:

```bash
git clone https://github.com/YOUR_USERNAME/my-mentraos-app
cd my-mentraos-app
```

## Part 2: Deploy to Railway

### 3. Create Railway Project

1. Go to [railway.com](https://railway.com)
2. Sign in with your GitHub account
3. Click **"Deploy a new project"**
4. Select **"Deploy from GitHub repo"**

### 4. Connect Your Repository

1. Select your new repository from the list
2. If you don't see it, click **"Configure GitHub App"** to give Railway access to your repositories
3. Once selected, Railway will start setting up your project

### 5. Get Your Public URL

1. Go to the **"Settings"** tab in your Railway project
2. Under **"Networking" > "Public Networking"**, click **"Generate Domain"**
3. You'll get a URL like: `yourapp-production-fa42.up.railway.app`
4. Copy this URL - you'll need it for the next step

## Part 3: Register Your App with MentraOS

### 6. Register in Developer Console

1. Navigate to [console.mentra.glass](https://console.mentra.glass)
2. Sign in with the same account you use for MentraOS
3. Click **"Create App"**
4. Fill in the details:
   - **Package Name**: Use the same package name from your environment variables
   - **Server URL**: Enter your Railway URL (e.g., `https://yourapp-production-fa42.up.railway.app`)
   - **Webview URL**: Enter `https://yourapp-production-fa42.up.railway.app/webview`
   - **Permissions**: Add the microphone permission.  See the [Permissions](permissions) guide for details.
5. Click **"Create App"**
6. Take note of the api key, as you will need it later and it won't be shown again

### 7. Import App Configuration

You can now add permissions, settings, and tools to your app via the MentraOS Developer Console. Instead of doing it manually, let's upload this example's [`app_config.json`](https://raw.githubusercontent.com/Mentra-Community/MentraOS-Extended-Example-App/refs/heads/main/app_config.json) file by clicking the **"Import app_config.json"** button under **Configuration Management**:

![Import app config](https://github.com/user-attachments/assets/14736150-7f02-43db-8b29-bbe918a4086b)

1. In the developer console, scroll to the **"Configuration Management"** section
2. Click **"Import app_config.json"**
3. Upload the `app_config.json` file from your cloned repository
4. This will automatically configure:
   - **Permissions**: Microphone access for speech recognition
   - **Settings**: Adds a toggle for show_live_transcription
   - **Tools**: Adds an example tool called my_tool_name
5. Click **"Save Changes"** to apply the configuration

### 8. Configure Environment Variables

1. In your Railway project dashboard, click on the **"Variables"** tab
2. Under **"Suggested Variables"**, you'll see template variables from the `.env.example` file
3. Replace the placeholder values:
   - **PACKAGE_NAME**: Change `org.yourname.appname` to your unique package name (e.g., `com.yourname.mymentraosapp`)
   - **MENTRAOS_API_KEY**: Replace `your_api_key_here` with your actual API key from the MentraOS Console
   - **PORT**: Leave as `3000`
4. Click **"Add All"** to save the variables

### 9. Deploy Your App

1. On the left side of the Railway dashboard, you'll see "Apply 3 changes"
2. Click the purple **"Deploy"** button
3. Railway will build and deploy your app (this takes 1-2 minutes)

## Part 4: Test Your Deployed App

### 10. Install MentraOS

If you haven't already:
1. Download the MentraOS app from [mentra.glass/os](https://mentra.glass/os)
2. Set up your smart glasses following the setup guide

### 11. Test Your App

1. Open the MentraOS app on your phone
2. Find your app in the app list and tap to start it
3. **Expected behavior:**
   - Spoken text should appear on your smart glasses display

### 12. Test the Webview

1. In the MentraOS phone app, tap the gear icon next to your app name
2. This opens the webview interface
3. **Expected behavior:**
   - You should see your username displayed

### 13. Test Settings
1. In the MentraOS phone app, with the webview interface open, tap the gear icon in the upper right
2. This opens the settings menu
3. **Expected behavior:**
   - You should see the "Show live transcription" setting
   - Tapping the setting should toggle the on-screen transcriptions on and off


## Part 5: Continuous Deployment

### 13. Make Changes and Deploy

Railway automatically deploys when you push changes to GitHub:

1. Make a change to your app locally (e.g., modify the welcome message in `src/index.ts`)
2. Commit and push your changes:
   ```bash
   git add .
   git commit -m "Update welcome message"
   git push origin main
   ```
3. Railway will automatically detect the changes and deploy within 1-2 minutes
4. To see the changes, restart your app in MentraOS:
   - Tap your app in the list to stop it
   - Tap again to restart it

## Next Steps

Congratulations! Your MentraOS app is now running in the cloud. Here's what you can do next:

### Explore Advanced Features

- **[Events](/events)**: Handle user interactions and sensor data
- **[Settings](/settings)**: Add configurable options for users
- **[AI Tools](/tools)**: Integrate with Mira AI for natural language interactions
- **[Webview Authentication](/webview-auth-overview)**: Build rich web interfaces

### Get Help

- **[Discord Community](https://discord.gg/5ukNvkEAqT)**: Get help from other developers
- **[Railway Documentation](https://docs.railway.app/)**: Learn more about Railway features
- **[MentraOS Documentation](/)**: Explore the full SDK documentation
- **[GitHub Examples](https://github.com/Mentra-Community)**: See more example projects

### Troubleshooting

**App not responding after deployment?**
- Check the Railway logs for errors
- Verify your environment variables are set correctly
- Ensure your API key is valid in the developer console

**Changes not appearing?**
- Confirm your GitHub push was successful
- Check Railway deployment status
- Restart your app in MentraOS after deployment completes

**Webview not loading?**
- Verify the webview URL is set correctly in the developer console
- Check that your Railway deployment is accessible at the public URL
- Load the webview URL directly in your browser to ensure it's accessible
