import type {
  MentraLivePairingController,
  MentraLivePairingGlasses,
  MentraLivePairingState,
} from '@mentra/engine/pairing';

export type CustomPairingAction = Exclude<
  keyof MentraLivePairingController,
  'state' | 'select' | 'cancelPairing'
>;

export type CustomPairingButton = {
  action: CustomPairingAction;
  label: string;
};

export type CustomPairingRow = {
  glasses: MentraLivePairingGlasses;
  label: string;
};

export type CustomPairingPresentation = {
  detail?: string;
  indeterminate?: boolean;
  message?: string;
  primary?: CustomPairingButton;
  rows?: CustomPairingRow[];
  secondary?: CustomPairingButton;
  /** Pair Audio during an attempt: leaving cancels the pairing, so the flow asks first. */
  confirmCancel?: boolean;
  steps?: string[];
  title: string;
  tone: 'active' | 'danger' | 'neutral' | 'success';
};

const failureMessages: Record<string, string> = {
  'errors:pairingCouldNotStart':
    "Couldn't start connecting to your glasses. Make sure Bluetooth is on and try again.",
  'errors:pairingBatteryTooLow':
    'The glasses battery is too low to pair. Charge them to at least 25% and try again.',
};

function scanRows(glasses: MentraLivePairingGlasses[]): CustomPairingRow[] {
  return glasses.map((item) => ({
    glasses: item,
    label: `Mentra Live ${item.label}`,
  }));
}

function scanPresentation(
  state: Extract<MentraLivePairingState, {page: 'scan'}>,
): CustomPairingPresentation {
  switch (state.status) {
    case 'searching':
      return {
        indeterminate: true,
        message: 'Press the power button 3 times quickly to enter pairing mode.',
        secondary: {action: 'back', label: 'Cancel'},
        title: 'Looking for Mentra Live',
        tone: 'active',
      };
    case 'choosing':
      return {
        detail: 'Match the code your glasses say.',
        indeterminate: state.scanning,
        primary: state.scanning ? undefined : {action: 'scanAgain', label: 'Scan again'},
        rows: scanRows(state.glasses),
        secondary: {action: 'back', label: 'Cancel'},
        title: 'Choose your glasses',
        tone: 'neutral',
      };
    case 'in_use':
      return {
        message: 'Matching glasses are already connected to this phone. Disconnect them in the other app, then scan again.',
        primary: {action: 'scanAgain', label: 'Scan again'},
        secondary: {action: 'back', label: 'Cancel'},
        title: 'Glasses already connected',
        tone: 'danger',
      };
    case 'not_found':
      return {
        message: 'Make sure your glasses are charged and on, then press the power button 3 times quickly.',
        primary: {action: 'scanAgain', label: 'Scan again'},
        secondary: {action: 'back', label: 'Cancel'},
        title: 'No glasses found',
        tone: 'danger',
      };
  }
}

export function pairingPresentation(state: MentraLivePairingState): CustomPairingPresentation {
  switch (state.page) {
    case 'prep':
      return {
        message: 'Hold the power button for 5 seconds. You will hear "Power on".',
        primary: {action: 'continueToScan', label: 'Continue'},
        secondary: {action: 'back', label: 'Cancel'},
        title: 'Turn on your glasses',
        tone: 'neutral',
      };
    case 'scan':
      return scanPresentation(state);
    case 'connecting':
      return {
        indeterminate: true,
        message: state.booting ? 'The glasses are still starting up…' : 'Keep the glasses close to this phone.',
        secondary: {action: 'back', label: 'Cancel'},
        title: `Pairing ${state.device.name}`,
        tone: 'active',
      };
    case 'pair_audio':
      return {
        confirmCancel: state.canCancel,
        message: `Connect ${state.deviceName} as a Bluetooth audio device.`,
        primary: {action: 'openBluetoothSettings', label: 'Open Settings'},
        steps: [
          'Open Settings, then Bluetooth.',
          `Tap "${state.deviceName}".`,
          'Come back once it says Connected.',
        ],
        title: 'Pair audio',
        tone: 'active',
      };
    case 'forget_ios_pairing':
      return {
        message: `This iPhone still has an old pairing for ${state.deviceName.replace(/_/g, ' ')}.`,
        primary: {action: 'openBluetoothSettings', label: 'Open Settings'},
        secondary: {action: 'back', label: 'Back'},
        steps: [
          'Open Settings, then Bluetooth.',
          'Tap ⓘ next to the glasses, then Forget This Device.',
          'Come back here to pair again.',
        ],
        title: 'Forget the old pairing',
        tone: 'danger',
      };
    case 'success':
      return {
        message: 'Your Mentra Live is paired with this phone.',
        primary: {action: 'finish', label: 'Done'},
        title: 'Paired',
        tone: 'success',
      };
    case 'failure':
      return {
        message: failureMessages[state.error] ?? 'Pairing failed. Try again.',
        primary: {action: 'retry', label: 'Try again'},
        secondary: {action: 'exit', label: 'Close'},
        title: 'Pairing failed',
        tone: 'danger',
      };
  }
}
