/**
 * offlineAppRegistry — packageName → screens for offline apps hosted in the
 * Compositor overlay by <OfflineAppHost />.
 *
 * The route components are the SAME expo-router screen modules used when the
 * routes are pushed normally (gear icon, deep links) — the screens stay
 * dual-mode. Route keys must match the paths the screens push via
 * useNavigationStore so the host's navigation interceptor can resolve them
 * onto its internal stack.
 */
import type {ComponentType} from "react"

import {cameraPackageName, feedbackPackageName, mirrorPackageName, settingsPackageName} from "@/constants/miniapps"
import {OFFLINE_HOSTED_PACKAGES} from "./offlineHostedPackages"

import GalleryScreen from "@/app/asg/gallery"
import GallerySettingsScreen from "@/app/asg/gallery-settings"
import DeveloperUrlScreen from "@/app/miniapps/miniappdev/developer-url"
import ScannerScreen from "@/app/miniapps/miniappdev/scanner"
import MirrorScreen from "@/app/miniapps/mirror/mirror"
import AppearanceSettings from "@/app/miniapps/settings/appearance"
import CameraSettings from "@/app/miniapps/settings/camera"
import ChangeEmailScreen from "@/app/miniapps/settings/change-email"
import ChangePasswordScreen from "@/app/miniapps/settings/change-password"
import ControllerSettings from "@/app/miniapps/settings/controller"
import DashboardSettings from "@/app/miniapps/settings/dashboard"
import DataExportScreen from "@/app/miniapps/settings/data-export"
import DebugSettings from "@/app/miniapps/settings/debug"
import DeviceInfoScreen from "@/app/miniapps/settings/device-info"
import FeedbackScreen from "@/app/miniapps/settings/feedback"
import GlassesMenuSettings from "@/app/miniapps/settings/glasses-menu"
import LayoutSettings from "@/app/miniapps/settings/layout"
import MainSettings from "@/app/miniapps/settings/main"
import MicrophoneSettings from "@/app/miniapps/settings/microphone"
import MiniappDevSettings from "@/app/miniapps/settings/miniapp-dev"
import NotificationSettings from "@/app/miniapps/settings/notifications"
import PositionSettings from "@/app/miniapps/settings/position"
import PrivacySettings from "@/app/miniapps/settings/privacy"
import ProfileSettings from "@/app/miniapps/settings/profile"
import SpeechSettings from "@/app/miniapps/settings/speech"
import StressTestScreen from "@/app/miniapps/settings/stress-test"
import SuperSettings from "@/app/miniapps/settings/super"

export interface OfflineAppDef {
  initialRoute: string
  routes: Record<string, ComponentType<any>>
}

const settingsRoutes: Record<string, ComponentType<any>> = {
  "/miniapps/settings/main": MainSettings,
  "/miniapps/settings/appearance": AppearanceSettings,
  "/miniapps/settings/camera": CameraSettings,
  "/miniapps/settings/change-email": ChangeEmailScreen,
  "/miniapps/settings/change-password": ChangePasswordScreen,
  "/miniapps/settings/controller": ControllerSettings,
  "/miniapps/settings/dashboard": DashboardSettings,
  "/miniapps/settings/data-export": DataExportScreen,
  "/miniapps/settings/debug": DebugSettings,
  "/miniapps/settings/device-info": DeviceInfoScreen,
  "/miniapps/settings/feedback": FeedbackScreen,
  "/miniapps/settings/glasses-menu": GlassesMenuSettings,
  "/miniapps/settings/layout": LayoutSettings,
  "/miniapps/settings/microphone": MicrophoneSettings,
  "/miniapps/settings/miniapp-dev": MiniappDevSettings,
  // Miniapp dev tools live under the Miniapp Developer settings screen now,
  // so their routes are hosted by the settings overlay (not a standalone app).
  "/miniapps/miniappdev/developer-url": DeveloperUrlScreen,
  "/miniapps/miniappdev/scanner": ScannerScreen,
  "/miniapps/settings/notifications": NotificationSettings,
  "/miniapps/settings/position": PositionSettings,
  "/miniapps/settings/privacy": PrivacySettings,
  "/miniapps/settings/profile": ProfileSettings,
  "/miniapps/settings/speech": SpeechSettings,
  "/miniapps/settings/stress-test": StressTestScreen,
  "/miniapps/settings/super": SuperSettings,
}

export const offlineAppRegistry: Record<string, OfflineAppDef> = {
  [settingsPackageName]: {
    initialRoute: "/miniapps/settings/main",
    routes: settingsRoutes,
  },
  [mirrorPackageName]: {
    initialRoute: "/miniapps/mirror/mirror",
    routes: {"/miniapps/mirror/mirror": MirrorScreen},
  },
  [cameraPackageName]: {
    initialRoute: "/asg/gallery",
    routes: {
      "/asg/gallery": GalleryScreen,
      "/asg/gallery-settings": GallerySettingsScreen,
      "/miniapps/settings/camera": CameraSettings,
    },
  },
  [feedbackPackageName]: {
    initialRoute: "/miniapps/settings/feedback",
    routes: {"/miniapps/settings/feedback": FeedbackScreen},
  },
}

if (__DEV__) {
  const registryKeys = new Set(Object.keys(offlineAppRegistry))
  for (const pkg of OFFLINE_HOSTED_PACKAGES) {
    if (!registryKeys.has(pkg)) console.error(`offlineAppRegistry: missing entry for hosted package ${pkg}`)
  }
  for (const pkg of registryKeys) {
    if (!OFFLINE_HOSTED_PACKAGES.has(pkg)) console.error(`offlineAppRegistry: ${pkg} not in OFFLINE_HOSTED_PACKAGES`)
  }
}
