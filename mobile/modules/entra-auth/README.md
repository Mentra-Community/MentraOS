# @mentra/entra-auth

Internal Expo module that gives the Mentra App a native Microsoft Entra public
client on Android and iOS. The deployment manifest supplies an exact tenant
authority and client id at runtime; no customer registration is compiled into
the official app.

The TypeScript API supports account restore, interactive sign-in, silent token
acquisition for an arbitrary declared scope set, and local sign-out. Android
uses MSAL's system-browser/broker flow and derives its redirect URI from the app
package plus signing certificate. iOS uses `msauth.<bundle-id>://auth` and the
standard MSAL keychain group.

This module is the first adapter behind the app's provider-neutral deployment
auth contract. Deployment schema v1 qualifies Microsoft Entra only.
