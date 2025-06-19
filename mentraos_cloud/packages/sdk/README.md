# @augmentos/sdk

Build Third Party Apps (TPAs) for AugmentOS smartglasses. This SDK provides everything you need to create real-time AR applications that respond to voice, head movements, and other inputs.

## 🚀 Building Your First App

The quickest way to get started is using our example app. This guide assumes you have a pair of [compatible smart glasses](https://augmentos.org/glasses) connected to a phone running the [AugmentOS app](https://augmentos.org/install).

### Install AugmentOS on your phone

Download AugmentOS from [AugmentOS.org/install](https://AugmentOS.org/install)

### Set up ngrok

1. [Install ngrok](https://ngrok.com/docs/getting-started/)
2. Create an ngrok account
3. [Set up a static address/URL in the ngrok dashboard](https://dashboard.ngrok.com/)

* Make sure you run the `ngrok config add-authtoken <your_authtoken>` line.
* Make sure you select `Static Domain`, then generate a static domain.

<center>
  <img width="75%" src="https://docs.augmentos.org/img/ngrok_guide_1.png"></img>
</center>

### Register your app with AugmentOS

![AugmentOS Console](https://github.com/user-attachments/assets/36192c2b-e1ba-423b-90de-47ff8cd91318)

1. Navigate to [console.AugmentOS.org](https://console.AugmentOS.org/)
2. Click "Sign In" and log in with the same account you're using for AugmentOS
3. Click "Create App"
4. Set a unique package name like `com.yourName.yourAppName`
5. For "Public URL", enter your ngrok static URL

### Get your app running

1. [Install bun](https://bun.sh/docs/installation)
2. Clone the example repo: 
   ```bash
   git clone git@github.com:AugmentOS-Community/AugmentOS-Cloud-Example-App.git
   ```
3. Navigate to the repo directory and install dependencies:
    ```bash
    cd AugmentOS-Cloud-Example-App
    bun install
    ```
4. Edit your `index.ts` to match the app you registered:
   ```typescript
   const app = new ExampleAugmentOSApp({
     packageName: 'com.yourName.yourAppName', // The packageName you specified on console.AugmentOS.org
     apiKey: 'your_api_key', // Get this from console.AugmentOS.org
     port: 3000 // The port you're hosting the server on
   });
   ```
5. Run your app:
   ```bash
   bun run index.ts
   ```
6. Expose your app to the internet with ngrok:
   ```bash
   ngrok http --url=<YOUR_NGROK_URL_HERE> 3000
   ```
   Note: `3000` is the port. It must match what is in the app config. If you changed it to `8080`, use `8080` for ngrok instead.

For more information, visit the [AugmentOS-Cloud-Example-App repository](https://github.com/AugmentOS-Community/AugmentOS-Cloud-Example-App).

## Next Steps

- Explore the [Getting Started (From Scratch)](getting-started) guide for a more detailed walkthrough
- Learn about [Core Concepts](core-concepts) to understand how AugmentOS apps work
- Join our [Discord community](https://discord.gg/5ukNvkEAqT) for help and support

## 📄 License

MIT License.