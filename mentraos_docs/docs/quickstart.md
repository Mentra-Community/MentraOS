---
sidebar_position: 2
---

# Quickstart

MentraOS is how you write powerful smart glasses apps. In this Quickstart, let's go from 0 to fully functioning app (that works on [these smart glasses](https://mentra.glass/os#glasses/)) in less than 15 minutes.

## Prerequisites

- Node.js (v18 or later)
- Bun
- Basic TypeScript knowledge

## Building Your First App

The quickest way to get started is using our example app. This guide assumes you have a pair of [compatible smart glasses](https://mentra.glass/os#glasses/) connected to a phone running the [MentraOS app](https://mentra.glass/os).

### Install MentraOS on your phone

Download MentraOS from [mentra.glass/os](https://mentra.glass/os)

### Set up ngrok

We are going to use ngrok to expose your local app to the internet.  This is useful for development, but when you're ready to go live, you'll want to deploy to a cloud service like [Railway](railway-deployment) or [an Ubuntu server](ubuntu-deployment).

1. [Install ngrok](https://ngrok.com/docs/getting-started/)
2. Create an ngrok account
3. [Set up a static address/URL in the ngrok dashboard](https://dashboard.ngrok.com/)

* Make sure you run the `ngrok config add-authtoken <your_authtoken>` line.
* Make sure you select `Static Domain`, then generate a static domain.

<center>
  <img width="75%" src="/img/ngrok_guide_1.png"></img>
</center>

### Register your app with MentraOS

![MentraOS Console](https://github.com/user-attachments/assets/36192c2b-e1ba-423b-90de-47ff8cd91318)

1. Navigate to [console.mentra.glass](https://console.mentra.glass/)
2. Click "Sign In" and log in with the same account you're using for MentraOS
3. Click "Create App"
4. Set a unique package name like `com.yourName.yourAppName`
5. For "Public URL", enter your ngrok static URL
6. In the edit app screen, add the microphone permission.  See the [Permissions](permissions) guide for details.

> This automatically installs the app for your user.  For other people to test the app (including others in your organization), they need to install the app.  Get the app install link from the app edit page under the `Share with Testers` section.

### Get your app running

1. [Install bun](https://bun.sh/docs/installation)
2. Create a new repo from the template using the `Use this template` dropdown in the upper right of [the example app repository](https://github.com/Mentra-Community/MentraOS-Cloud-Example-App) or the following command:
   ```bash
   gh repo create --template Mentra-Community/MentraOS-Cloud-Example-App
   ```

   ![Create repo from template](https://github.com/user-attachments/assets/c10e14e8-2dc5-4dfa-adac-dd334c1b73a5)

   **Note:** If you want a more in-depth example (recommended for those who've already completed this quickstart), you can use the [Extended Example](https://github.com/Mentra-Community/MentraOS-Extended-Example-App) which includes app settings support.
3. Clone your new repo locally:
   ```bash
   git clone <your-repo-url>
   ```
4. Navigate to your repo directory and install dependencies:
   ```bash
   cd <your-repo-name>
   bun install
   ```
5. Set up your environment variables:
   * Create a `.env` file in the root directory by copying the example:
     ```bash
     cp .env.example .env
     ```
   * Edit the `.env` file with your app details:
     ```
     PORT=3000
     PACKAGE_NAME=com.yourName.yourAppName
     MENTRAOS_API_KEY=your_api_key_from_console
     ```
   * Make sure the `PACKAGE_NAME` matches what you registered in the MentraOS Console
   * Get your `API_KEY` from the MentraOS Developer Console
6. Run your app:
   ```bash
   bun run dev
   ```
7. Expose your app to the internet with ngrok:
   ```bash
   ngrok http --url=<YOUR_NGROK_URL_HERE> 3000
   ```
   Note: `3000` is the port. It must match what is in the app config. If you changed it to `8080`, use `8080` for ngrok instead.

> **IMPORTANT:** After making changes to your app code or restarting your server, you must restart your app inside the MentraOS phone app.

For more information, visit the [MentraOS-Cloud-Example-App repository](https://github.com/Mentra-Community/MentraOS-Cloud-Example-App). For a more in-depth example with app settings support, see the [Extended Example](https://github.com/Mentra-Community/MentraOS-Extended-Example-App).

## Next Steps

- Explore the [Build From Scratch](/getting-started) guide for a more detailed walkthrough
- For a more in-depth example with app settings support, see the [Extended Example](https://github.com/Mentra-Community/MentraOS-Extended-Example-App)
- Learn about [Core Concepts](/core-concepts) to understand how MentraOS apps work
- Read about [Permissions](/permissions) to access device capabilities like microphone and location
- Join our [Discord community](https://discord.gg/5ukNvkEAqT) for help and support