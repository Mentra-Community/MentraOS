import type {
  MentraLiveOtaController,
  MentraLiveOtaState,
  MentraLiveOtaStep,
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
  message: string;
  primary?: CustomOtaButton;
  progress?: number;
  secondary?: CustomOtaButton;
  title: string;
  tone: 'active' | 'danger' | 'neutral' | 'success';
};

type OtaStateWithChangelogs = MentraLiveOtaState & {
  changelogs?: CustomOtaChangelog[];
};

function stepLabel(step: MentraLiveOtaStep | null): string {
  switch (step) {
    case 'apk':
      return 'glasses app';
    case 'mtk':
      return 'system software';
    case 'bes':
      return 'firmware';
    default:
      return 'software';
  }
}
function transportDetail(state: MentraLiveOtaState): string | undefined {
  if (state.transport === 'hotspot') {
    return 'The phone will transfer the verified files over the glasses hotspot.';
  }
  if (state.transport === 'wifi') {
    return 'The glasses will download the update over their saved Wi-Fi network.';
  }
  return undefined;
}

function progressDetail(state: MentraLiveOtaState): string | undefined {
  if (state.currentStep !== null && state.totalSteps !== null) {
    return `Step ${state.currentStep} of ${state.totalSteps}: ${stepLabel(state.step)}`;
  }
  if (state.step) return `Updating ${stepLabel(state.step)}`;
  return transportDetail(state);
}

export function otaPresentation(
  state: MentraLiveOtaState,
  deviceName = 'Mentra Live',
): CustomOtaPresentation {
  const changelogs = (state as OtaStateWithChangelogs).changelogs ?? [];

  if (state.versionChangePhase === 'restarting') {
    return {
      detail: 'The glasses can restart more than once during a version change.',
      indeterminate: true,
      message: 'Keep your glasses nearby. They will reconnect automatically.',
      title: 'Restarting your glasses',
      tone: 'active',
    };
  }

  if (state.versionChangePhase === 'verifying') {
    return {
      indeterminate: true,
      message: 'Engine is checking every installed component before continuing.',
      title: 'Verifying the version change',
      tone: 'active',
    };
  }

  switch (state.screen) {
    case 'initializing':
      return {
        indeterminate: true,
        message: 'Preparing the shared Mentra Engine update controller.',
        title: 'Preparing software update',
        tone: 'active',
      };
    case 'checking':
      return {
        indeterminate: true,
        message: 'Comparing the app, system software, and firmware with this SDK release.',
        title: `Checking ${deviceName}`,
        tone: 'active',
      };
    case 'update_available':
      return {
        detail: transportDetail(state),
        message: state.versionChange
          ? 'This SDK release requires a different glasses software version. Settings may be reset and restored automatically.'
          : 'A matching software update is ready for your glasses.',
        primary: {
          action: 'install',
          disabled: !state.canInstall,
          label: state.versionChange ? 'Change version' : 'Update now',
        },
        secondary: state.canDismiss
          ? {action: 'finish', label: 'Later'}
          : undefined,
        title: state.versionChange ? 'Version change required' : 'Update available',
        tone: 'active',
      };
    case 'wifi_required':
      return {
        detail: 'Older glasses software does not support hotspot OTA, so it needs a saved Wi-Fi network for this update.',
        message: `Connect ${deviceName} to Wi-Fi, then the update check will resume.`,
        primary: {action: 'openWifiSetup', label: 'Set up Wi-Fi'},
        secondary: state.canDismiss
          ? {action: 'finish', label: 'Later'}
          : undefined,
        title: 'Wi-Fi required',
        tone: 'neutral',
      };
    case 'up_to_date':
      return {
        changelogs,
        message: 'The glasses app, system software, and firmware match this SDK release.',
        primary: {action: 'finish', label: 'Continue'},
        title: 'Everything is up to date',
        tone: 'success',
      };
    case 'dev_build':
      return {
        detail: 'Set EXPO_PUBLIC_ASG_OTA_VERSION_URL when you intentionally want to test an OTA manifest.',
        message: 'Automatic glasses updates are disabled for this development build.',
        primary: {action: 'finish', label: 'Continue'},
        title: 'OTA disabled in dev build',
        tone: 'neutral',
      };
    case 'check_failed':
      return {
        message: state.error?.message ?? 'The app could not check for updates.',
        primary: {action: 'retryCheck', label: 'Try again'},
        title: 'Update check failed',
        tone: 'danger',
      };
    case 'update_info_unavailable':
      return {
        message: state.error?.message ?? 'This app release does not have matching update information.',
        primary: {action: 'finish', label: 'Continue'},
        title: 'Update information unavailable',
        tone: 'danger',
      };
    case 'starting':
    case 'preparing_hotspot': {
      const hotspotCopy = {
        downloading: {
          message: 'The update is verified on the phone before the hotspot transfer begins.',
          title: 'Downloading update to phone',
        },
        starting_hotspot: {
          message: 'The glasses are creating a temporary local network.',
          title: 'Starting glasses hotspot',
        },
        joining_hotspot: {
          message: 'The phone is joining the glasses network. No internet connection is required.',
          title: 'Connecting to glasses',
        },
        serving: {
          message: 'The glasses can now download the verified update from this phone.',
          title: 'Starting update transfer',
        },
        idle: {
          message: 'Engine is preparing the next update step.',
          title: 'Starting update',
        },
      }[state.hotspotPhase];
      return {
        detail: 'Keep the phone and glasses nearby.',
        indeterminate: state.hotspotArtifactPercent === null,
        message: hotspotCopy.message,
        progress: state.hotspotArtifactPercent ?? undefined,
        title: hotspotCopy.title,
        tone: 'active',
      };
    }
    case 'updating':
      return {
        detail: progressDetail(state),
        indeterminate: state.progress === null || state.installingApkOnly,
        message: 'Do not disconnect or power off the glasses.',
        progress: state.installingApkOnly ? undefined : (state.progress ?? undefined),
        title: `${state.phase === 'download' ? 'Downloading' : 'Installing'} ${stepLabel(state.step)}`,
        tone: 'active',
      };
    case 'restarting':
      return {
        message: 'The update is installed and the glasses are ready to continue.',
        primary: {
          action: 'finish',
          disabled: state.continueDisabled,
          label: 'Continue',
        },
        title: 'Update installed',
        tone: 'success',
      };
    case 'verifying':
      return {
        indeterminate: true,
        message: 'Engine is confirming the installed versions before returning to the app.',
        title: 'Verifying update',
        tone: 'active',
      };
    case 'complete':
      return {
        changelogs,
        message: state.versionChange
          ? 'The required software version is installed and the glasses are ready.'
          : 'Your glasses now match this SDK release.',
        primary: {action: 'finish', label: state.versionChange && !state.versionChangeConverged ? 'Continue' : 'Done'},
        title: state.versionChange ? 'Version change complete' : 'Update complete',
        tone: 'success',
      };
    case 'failed':
      return {
        message: state.error?.message ?? 'The update did not finish.',
        primary: state.canRetry
          ? {action: 'retryInstall', label: 'Try again'}
          : state.canFinish
            ? {action: 'finish', label: 'Done'}
            : undefined,
        secondary: state.canOpenWifiSetup
          ? {action: 'openWifiSetup', label: 'Change Wi-Fi'}
          : undefined,
        title: 'Update failed',
        tone: 'danger',
      };
    case 'disconnected':
      return {
        indeterminate: true,
        message: 'Keep the glasses nearby. The update will continue when Bluetooth reconnects.',
        title: 'Reconnecting to glasses',
        tone: 'active',
      };
    default: {
      const exhaustive: never = state.screen;
      return exhaustive;
    }
  }
}
