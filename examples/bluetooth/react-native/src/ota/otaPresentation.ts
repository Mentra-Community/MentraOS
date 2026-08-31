import type {
  MentraLiveOtaController,
  MentraLiveOtaState,
} from '@mentra/engine/ota';

export type CustomOtaAction = Exclude<
  keyof MentraLiveOtaController,
  'state'
>;

export type CustomOtaButton = {
  action: CustomOtaAction;
  disabled?: boolean;
  label: string;
};

export type CustomOtaChangelog = {
  markdown: string;
  version: string;
};

export type CustomOtaPresentation = {
  changelogs?: CustomOtaChangelog[];
  detail?: string;
  indeterminate?: boolean;
  message?: string;
  primary?: CustomOtaButton;
  progress?: number;
  secondary?: CustomOtaButton;
  title: string;
  tone: 'active' | 'danger' | 'neutral' | 'success';
  versionLabel?: string;
};

function updateVersionLabel(transition: MentraLiveOtaState['releaseTransition']): string | undefined {
  if (!transition) return undefined;
  return `${transition.fromVersion ?? 'Current version unknown'} → ${transition.toVersion}`;
}

function completedVersionLabel(transition: MentraLiveOtaState['releaseTransition']): string | undefined {
  return transition ? `Updated to ${transition.toVersion}` : undefined;
}

export function otaPresentation(
  state: MentraLiveOtaState,
  deviceName = 'Mentra Live',
): CustomOtaPresentation {
  const {changelogs, releaseTransition} = state;

  if (state.versionChangePhase === 'restarting') {
    return {
      detail: 'Your glasses will restart twice — this may take up to 2 minutes.',
      indeterminate: true,
      message: 'Keep your glasses nearby and connected. They will restart on their own.',
      title: 'Installing a different version…',
      tone: 'active',
    };
  }

  if (state.versionChangePhase === 'verifying') {
    return {
      detail: 'Your glasses will restart twice — this may take up to 2 minutes.',
      indeterminate: true,
      message: 'Keep your glasses nearby and connected. They will restart on their own.',
      title: 'Verifying your glasses…',
      tone: 'active',
    };
  }

  switch (state.screen) {
    case 'initializing':
      return {
        indeterminate: true,
        title: 'Checking for updates',
        tone: 'active',
      };
    case 'checking':
      return {
        indeterminate: true,
        message: 'Connected devices will perform automatic updates. Automatic updates can be disabled in Device Settings',
        title: 'Checking for updates',
        tone: 'active',
      };
    case 'finishing':
      return {
        indeterminate: true,
        message: 'Checking whether your glasses need any additional updates.',
        title: 'Finishing your update',
        tone: 'active',
      };
    case 'update_available':
      return {
        detail: 'Your glasses may install more than one update and restart several times. Keep them nearby until finished.',
        message: state.versionChange
          ? 'This app requires an earlier glasses software version. Your photos and videos will be preserved, but glasses settings will be reset and restored automatically after the change.'
          : 'A new update is available for your glasses. We recommend updating now for the best experience.',
        primary: {
          action: 'install',
          disabled: !state.wifiStatusKnown,
          label: 'Update Now',
        },
        secondary: state.canDismiss
          ? {action: 'finish', label: 'Later'}
          : undefined,
        title: state.versionChange
          ? `${deviceName} Version Change Required`
          : `${deviceName} Update Available`,
        tone: 'active',
        versionLabel: updateVersionLabel(releaseTransition),
      };
    case 'battery_required':
      return {
        detail: 'This screen will update automatically as the battery charges.',
        message: `${deviceName} is currently at ${state.batteryLevel}%. Charge it to at least 25% before updating.`,
        primary: {
          action: 'install',
          disabled: true,
          label: 'Update Now',
        },
        secondary: state.canDismiss
          ? {action: 'finish', label: 'Later'}
          : undefined,
        title: `Charge ${deviceName} to Update`,
        tone: 'neutral',
      };
    case 'wifi_required':
      return {
        detail: 'Your glasses may install more than one update and restart several times. Keep them nearby until finished.',
        message: `Connect your ${deviceName} to WiFi to install the update.`,
        primary: {
          action: 'openWifiSetup',
          disabled: !state.wifiStatusKnown,
          label: 'Setup WiFi',
        },
        secondary: state.canDismiss
          ? {action: 'finish', label: 'Later'}
          : undefined,
        title: 'WiFi Needed for Update',
        tone: 'neutral',
        versionLabel: updateVersionLabel(releaseTransition),
      };
    case 'up_to_date':
      return {
        changelogs,
        message: 'Your glasses are running the latest version.',
        primary: {action: 'finish', label: state.completedUpdate ? 'Done' : 'Continue'},
        title: state.completedUpdate ? 'Update complete' : 'Up To Date',
        tone: 'success',
        versionLabel: completedVersionLabel(releaseTransition),
      };
    case 'dev_build':
      return {
        detail: 'Set EXPO_PUBLIC_ASG_OTA_VERSION_URL when you intentionally want to test an OTA manifest.',
        message: 'This mobile app is a development build, so automatic glasses updates are disabled.',
        primary: {action: 'finish', label: 'Continue'},
        title: 'Development Build',
        tone: 'neutral',
      };
    case 'check_failed':
      return {
        message: "Couldn't check for updates. Please check your connection and try again.",
        primary: {action: 'retryCheck', label: 'Retry'},
        title: 'Check Failed',
        tone: 'danger',
      };
    case 'update_info_unavailable':
      return {
        message: 'Update information for this version of the app is unavailable. Please check the app store for a newer version of the Mentra App.',
        primary: {action: 'finish', label: 'Continue'},
        title: 'Update Info Unavailable',
        tone: 'danger',
      };
    case 'starting':
    case 'preparing_hotspot': {
      const hotspotCopy = {
        downloading: {
          title: 'Downloading update to phone...',
        },
        starting_hotspot: {
          title: 'Starting glasses hotspot...',
        },
        joining_hotspot: {
          title: 'Connecting phone to glasses...',
        },
        serving: {
          title: 'Starting update...',
        },
        idle: {
          title: 'Starting update...',
        },
      }[state.hotspotPhase];
      return {
        indeterminate: true,
        message: 'Do not disconnect your glasses',
        progress: state.hotspotPhase === 'downloading'
          ? (state.hotspotArtifactPercent ?? undefined)
          : undefined,
        title: hotspotCopy.title,
        tone: 'active',
      };
    }
    case 'updating':
      return {
        detail: state.versionChange && state.phase === 'install'
          ? 'Your glasses will restart twice — this may take up to 2 minutes.'
          : undefined,
        indeterminate: state.installingApkOnly || state.progress === null,
        message: 'Do not disconnect your glasses',
        progress: state.installingApkOnly ? undefined : (state.progress ?? undefined),
        title: state.phase === 'download' ? 'Downloading...' : 'Installing...',
        tone: 'active',
      };
    case 'restarting':
      return {
        detail: "We'll continue automatically when they're ready.",
        indeterminate: true,
        message: 'The update is installed. Keep your glasses nearby and leave this screen open while they finish starting.',
        title: `Restarting ${deviceName}…`,
        tone: 'active',
      };
    case 'verifying':
      return {
        detail: 'Your glasses will restart twice — this may take up to 2 minutes.',
        indeterminate: true,
        message: 'Keep your glasses nearby and connected. They will restart on their own.',
        title: 'Verifying your glasses…',
        tone: 'active',
      };
    case 'complete':
      return {
        changelogs,
        message: state.versionChangeConverged
          ? 'Your glasses are now on the required version. Their settings were reset and are being restored automatically.'
          : state.versionChange
            ? "Your glasses restarted with new firmware. One more step: they'll now continue to the required version."
            : 'Your glasses are up to date.',
        primary: {action: 'finish', label: state.versionChange && !state.versionChangeConverged ? 'Continue' : 'Done'},
        title: state.versionChangeConverged
          ? 'Version Change Complete'
          : state.versionChange
            ? 'Firmware updated'
            : 'Update complete!',
        tone: 'success',
        versionLabel: completedVersionLabel(releaseTransition),
      };
    case 'failed':
      return {
        message: state.error?.message,
        primary: state.canRetry
          ? {action: 'retryInstall', label: 'Retry'}
          : state.canFinish
            ? {action: 'finish', label: 'Done'}
            : undefined,
        secondary: state.canOpenWifiSetup
          ? {action: 'openWifiSetup', label: 'Change WiFi'}
          : undefined,
        title: 'Update Failed',
        tone: 'danger',
      };
    case 'disconnected':
      return {
        indeterminate: true,
        message: 'Reconnecting...',
        title: 'Glasses disconnected',
        tone: 'active',
      };
    default: {
      const exhaustive: never = state.screen;
      return exhaustive;
    }
  }
}
