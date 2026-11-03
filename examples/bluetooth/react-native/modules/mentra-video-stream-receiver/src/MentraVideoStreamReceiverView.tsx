import { requireNativeView } from 'expo';
import * as React from 'react';

import { MentraVideoStreamReceiverViewProps } from './MentraVideoStreamReceiver.types';

const NativeView: React.ComponentType<MentraVideoStreamReceiverViewProps> =
  requireNativeView('MentraVideoStreamReceiver');

export default function MentraVideoStreamReceiverView(props: MentraVideoStreamReceiverViewProps) {
  return <NativeView {...props} />;
}
