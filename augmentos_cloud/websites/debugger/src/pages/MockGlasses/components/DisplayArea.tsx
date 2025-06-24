import React from 'react';
import { Layout } from '@mentra/types';
import LayoutRenderer  from './LayoutRenderer';

interface DisplayAreaProps {
  layout: Layout | null;
}

export const DisplayArea: React.FC<DisplayAreaProps> = ({ layout }) => {
  return (
    <div className="flex-1 flex flex-col items-center justify-center mb-4">
      <div className="border border-green-700 rounded-lg p-4 h-48 w-96 overflow-y-auto text-green-600 mb-4">
        {/* {layout && (<LayoutRenderer layout={layout} />)} */}
        {
          JSON.stringify(layout)
        }
      </div>
    </div>
  );
};
