<div align="center">
  <img src="./images/Github-Readme.png" alt="Mentra: The open source smart glasses operating system" width="100%" />

  <p>
    <a href="https://mentra.glass">Website</a> •
    <a href="https://docs.mentra.glass">Documentation</a> •
    <a href="https://console.mentra.glass">Developer Console</a> •
    <a href="https://apps.mentra.glass">Mentra MiniApp Store</a>
  </p>

  <!--
  <p>
    <img src="https://img.shields.io/github/contributors/TeamOpenSmartGlasses/DiscussPlusPlus" alt="Contributors" />
    <img src="https://img.shields.io/github/license/TeamOpenSmartGlasses/DiscussPlusPlus" alt="License" />
    <img src="https://img.shields.io/github/stars/TeamOpenSmartGlasses/DiscussPlusPlus?style=social" alt="GitHub Stars" />
    <img src="https://img.shields.io/github/v/release/TeamOpenSmartGlasses/DiscussPlusPlus" alt="GitHub Release Version" />
    <img src="https://img.shields.io/github/last-commit/TeamOpenSmartGlasses/DiscussPlusPlus" alt="Last Updated" />
  </p>
  -->
</div>

<div align="center">
  <a href="https://apps.apple.com/us/app/mentra-the-smart-glasses-app/id6747363193">
    <img src="./images/AppStoreBadge.png" alt="Download on the App Store" width="180">
  </a>
  <a href="https://play.google.com/store/apps/details?id=com.mentra.mentra">
    <img src="./images/GooglePlayBadge.png" alt="Get it on Google Play" width="180">
  </a>
</div>

## Write Once, Run on Any Smart Glasses

MentraOS is how developers and businesses build smart glasses apps.

MentraOS handles pairing, connection, data streaming, hardware access, and cross-device compatibility, so you can focus on building amazing apps. Development goes from months to days.

Every component is open source under the MIT license, giving you privacy, freedom, and control.

## Choose the Right SDK

<table>
  <thead>
    <tr>
      <th>What you are building</th>
      <th>Use this SDK</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>
        A miniapp that runs inside the Mentra App, with the glasses connection,
        update flows, text-to-speech, speech-to-text, livestreaming
        infrastructure, and other platform services provided for you.
      </td>
      <td>
        <strong>Mentra Miniapp SDK</strong><br />
        <code>@mentra/miniapp</code><br />
        <a href="https://docs.mentra.glass/app-devs/getting-started/overview">Miniapp SDK docs</a>
      </td>
    </tr>
    <tr>
      <td>
        Your own Android, iOS, or React Native mobile app that connects to and
        controls Mentra Live directly.
      </td>
      <td>
        <strong>Mentra Bluetooth SDK</strong><br />
        <code>@mentra/bluetooth-sdk</code><br />
        <a href="https://docs.mentra.glass/mentra-live/overview">Bluetooth SDK docs</a> ·
        <a href="https://github.com/Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit">Starter Kit</a>
      </td>
    </tr>
  </tbody>
</table>

> **Already have a mobile app and want to integrate Mentra Live?** Use the
> [Mentra Bluetooth SDK](https://docs.mentra.glass/mentra-live/overview). Do not
> copy the Bluetooth implementation out of this monorepo or build a replacement
> SDK from MentraOS internals—the public SDK already handles scanning, pairing,
> connection state, protocol compatibility, events, and updates.

## Supported Smart Glasses

MentraOS works across a growing ecosystem of smart glasses.

<div align="center">
  <table border="0" cellspacing="0" cellpadding="0" width="100%" style="border: 0 !important; border-collapse: separate; border-spacing: 8px;">
    <tbody>
      <tr style="border: 0 !important; background: transparent;">
        <td align="center" valign="top" width="20%" style="border: 1px solid #e5e7eb; border-radius: 14px; padding: 24px 12px 12px; background: #ffffff;">
          <br />
          <img src="./images/glasses/mentra-live.png" alt="Mentra Live" width="140" />
          <br /><br />
          <p align="center"><b>Mentra Live</b></p>
        </td>
        <td align="center" valign="top" width="20%" style="border: 1px solid #bbf7d0; border-radius: 14px; padding: 24px 12px 12px; background: #ffffff;">
          <br />
          <img src="./images/glasses/even-realities-g2.png" alt="Even Realities G2" width="140" />
          <br /><br />
          <p align="center"><b>Even Realities G2</b></p>
        </td>
        <td align="center" valign="top" width="20%" style="border: 1px solid #e5e7eb; border-radius: 14px; padding: 24px 12px 12px; background: #ffffff;">
          <br />
          <img src="./images/glasses/vuzix-z100.png" alt="Vuzix Z100" width="140" />
          <br /><br />
          <p align="center"><b>Vuzix Z100</b></p>
        </td>
        <td align="center" valign="top" width="20%" style="border: 1px solid #e5e7eb; border-radius: 14px; padding: 24px 12px 12px; background: #ffffff;">
          <br />
          <img src="./images/glasses/even-realities-g1.png" alt="Even Realities G1" width="140" />
          <br /><br />
          <p align="center"><b>Even Realities G1</b></p>
        </td>
        <td align="center" valign="top" width="20%" style="border: 1px solid #fed7aa; border-radius: 14px; padding: 24px 12px 12px; background: #ffffff;">
          <br />
          <img src="./images/glasses/nimo.png" alt="NIMO" width="95" />
          <br /><br />
          <p align="center"><b>NIMO&nbsp;(Coming&nbsp;Soon)</b></p>
        </td>
      </tr>
    </tbody>
  </table>
</div>

## Why Build with MentraOS?

- **Cross-Compatibility:** Build one app that runs on supported smart glasses from multiple manufacturers.
- **Fast Development:** Go from months of custom smart glasses development to a working app in days.
- **Hardware Access:** Use displays, microphones, cameras, speakers, and everything else smart glasses expose from one API.
- **App Distribution:** Publish to the Mentra MiniApp Store and reach users across the MentraOS ecosystem.
- **Business Deployment:** Deploy smart glasses apps for field work, remote support, training, accessibility, and compliance-sensitive workflows. MentraOS is already being deployed by Fortune 500 companies.
- **Open Source Control:** Own it, host it, modify it, and extend it. MentraOS is MIT-licensed infrastructure designed for privacy, transparency, and freedom from hardware or cloud lock-in.

## Apps on the Mentra MiniApp Store

Browse, install, and run glasses apps from your phone. Try captions, AI notes, proactive AI, translation, streaming, and more.

<div align="center">
  <img src="./images/Mockup_appshomepage.png" alt="MentraOS glasses apps homepage" width="364" />
</div>

## How MentraOS Works

MentraOS runs glasses apps on the phone inside the Mentra Runtime. Multiple glasses apps can run simultaneously, controlling your smart glasses through one shared connection.

This keeps the glasses lightweight while letting multiple apps run together, like captions, notes, notifications, dashboard, and AI tools. It also allows one app to work with any pair of supported smart glasses.

Manufacturers can integrate the Mentra Runtime into their own iOS and Android apps to unlock the Mentra ecosystem while preserving their brand, app, and customer relationship.

## Nightly Builds

<div align="center">
  <p>
    <a href="https://github.com/TeamOpenSmartGlasses/DiscussPlusPlus/releases/download/nightly-builds/mobile-latest.apk">
      <img src="https://img.shields.io/badge/Mobile_App-Download_APK-blue?style=for-the-badge&logo=android" alt="Download Mobile APK" />
    </a>
    <a href="https://github.com/TeamOpenSmartGlasses/DiscussPlusPlus/releases/download/nightly-builds/asg-latest.apk">
      <img src="https://img.shields.io/badge/ASG_Client-Download_APK-green?style=for-the-badge&logo=android" alt="Download ASG APK" />
    </a>
  </p>
</div>

## Community

MentraOS is built by developers, companies, and users who believe the next personal computer should be open, cross-compatible, private, and user-controlled.

Join us and become part of the Mentra Community by joining our Discord server:  
[https://mentra.glass/discord](https://mentra.glass/discord)

## Contributing

MentraOS is made by a community and we welcome pull requests.

**Contributor guide:**  
[https://docs.mentraglass.com/os-devs/contributing/overview](https://docs.mentraglass.com/os-devs/contributing/overview)

Looking for ways to contribute? We mark issues we'd love the community to help with using the "Help Wanted" tag.

**Help wanted issues:**  
[https://github.com/Mentra-Community/MentraOS/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22help%20wanted%22](https://github.com/Mentra-Community/MentraOS/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22help%20wanted%22)

## Contact

- **Email:** [team@mentra.glass](mailto:team@mentra.glass)
- **Discord:** [https://mentra.glass/discord](https://mentra.glass/discord)
- **X:** [https://x.com/mentraglass](https://x.com/mentraglass)

## License

MIT License

Copyright 2026 Mentra Labs, Inc.

<div align="center">
  <br />
  <img width="100" alt="MentraOS" src="./images/MentraLogoWhiteSquare.svg" style="border-radius: 20%;" />
  <h3>© 2026 Mentra Labs, Inc.</h3>
</div>
