import * as React from 'react';

import { CrustViewProps } from './Crust.types';

export default function CrustView(props: CrustViewProps) {
  return (
    <div>
      <iframe
        style={{ flex: 1 }}
        src={props.url}
        onLoad={() => props.onLoad({ nativeEvent: { url: props.url } })}
      />
    </div>
  );
}
