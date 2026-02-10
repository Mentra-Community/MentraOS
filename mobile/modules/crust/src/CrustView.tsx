import { requireNativeView } from 'expo';
import * as React from 'react';

import { CrustViewProps } from './Crust.types';

const NativeView: React.ComponentType<CrustViewProps> =
  requireNativeView('Crust');

export default function CrustView(props: CrustViewProps) {
  return <NativeView {...props} />;
}
