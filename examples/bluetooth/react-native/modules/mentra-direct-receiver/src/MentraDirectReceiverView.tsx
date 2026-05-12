import { requireNativeView } from 'expo';
import * as React from 'react';

import { MentraDirectReceiverViewProps } from './MentraDirectReceiver.types';

const NativeView: React.ComponentType<MentraDirectReceiverViewProps> =
  requireNativeView('MentraDirectReceiver');

export default function MentraDirectReceiverView(props: MentraDirectReceiverViewProps) {
  return <NativeView {...props} />;
}
