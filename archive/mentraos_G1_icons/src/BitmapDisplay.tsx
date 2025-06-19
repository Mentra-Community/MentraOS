// BitmapDisplay.tsx
import { useState, useEffect } from 'react';

interface Glyph {
  code_point: number;
  char: string;
  width: number;
  height: number;
}

interface BitmapDisplayProps {
  fontName: string;
  glyph: Glyph;
  size?: 'normal' | 'large';
}

// Helper function to convert code point to hex filename
const getHexFilename = (codePoint: number): string => {
  return `0x${codePoint.toString(16).padStart(2, '0')}`;
};

export const BitmapDisplay = ({ 
  fontName, 
  glyph, 
  size = 'normal' 
}: BitmapDisplayProps) => {
  const [bitmapUrl, setBitmapUrl] = useState<string | undefined>();
  
  useEffect(() => {
    const loadBitmap = async () => {
      try {
        const hexName = getHexFilename(glyph.code_point);
        const bmpPath = `/even-fonts/${fontName}/${hexName}.bmp`;
        const response = await fetch(bmpPath);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        setBitmapUrl(url);

        // Cleanup previous URL when setting new one
        return () => URL.revokeObjectURL(url);
      } catch (error) {
        console.error('Error loading bitmap:', error);
      }
    };

    loadBitmap();
  }, [fontName, glyph.code_point]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (bitmapUrl) {
        URL.revokeObjectURL(bitmapUrl);
      }
    };
  }, [bitmapUrl]);

  const containerClass = size === 'large' 
    ? 'w-96 h-96'
    : 'w-32 h-32';

  const imageClass = size === 'large'
    ? 'h-64'
    : 'h-24';

  return (
    <div className={`${containerClass} bg-gray-800 rounded flex items-center justify-center p-2`}>
      {bitmapUrl ? (
        <img 
          src={bitmapUrl} 
          alt={`Character ${glyph.char}`}
          className={`
            ${imageClass}
            object-contain
            image-rendering-pixelated
          `}
          style={{
            imageRendering: 'pixelated',
            // WebkitImageRendering: 'pixelated',
            // msImageRendering: 'pixelated',
            // imageRendering: '-moz-crisp-edges',
          }}
        />
      ) : (
        <div className="animate-pulse bg-gray-200 w-full h-full rounded" />
      )}
    </div>
  );
};

export type { Glyph, BitmapDisplayProps };
export { getHexFilename };