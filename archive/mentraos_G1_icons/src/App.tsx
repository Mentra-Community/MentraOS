import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';

// Import font data directly
import clockLgData from './assets/even-fonts/clock-lg/font.json';
import clockMdData from './assets/even-fonts/clock-md/font.json';
import defaultFontData from './assets/even-fonts/default/font.json';
import extendedFontData from './assets/even-fonts/extended/font.json';

interface Glyph {
  code_point: number;
  char: string;
  width: number;
  height: number;
}

interface FontData {
  font: string;
  glyphs: Glyph[];
}

const FONTS: { [key: string]: FontData } = {
  'clock-lg': clockLgData,
  'clock-md': clockMdData,
  'default': defaultFontData,
  'extended': extendedFontData
};

// Convert code point to hex filename format (e.g., 58 -> "0x3a")
const getHexFilename = (codePoint: number): string => {
  return `0x${codePoint.toString(16)}`;
};

interface BitmapDisplayProps {
  fontName: string;
  glyph: Glyph;
  size?: 'normal' | 'large';
}

// Component to display bitmap image
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
    <div className={`${containerClass} bg-black/80 rounded flex items-center justify-center p-2`}>
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

const CharacterCard = ({ 
  fontName,
  glyph, 
  onClick 
}: { 
  fontName: string;
  glyph: Glyph; 
  onClick: () => void 
}) => (
  <div 
    onClick={onClick}
    className="p-4 border rounded-lg bg-white shadow-sm hover:shadow-md transition-all cursor-pointer flex flex-col items-center justify-center gap-2"
  >
    <BitmapDisplay fontName={fontName} glyph={glyph} />
    <div className="text-sm text-gray-500 mt-2">{glyph.width}x{glyph.height}</div>
    <div className="text-xs text-gray-400">
      {getHexFilename(glyph.code_point)}
    </div>
  </div>
);

const DetailModal = ({ 
  fontName,
  glyph, 
  onClose 
}: { 
  fontName: string;
  glyph: Glyph; 
  onClose: () => void 
}) => (
  <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4">
    <div className="bg-white rounded-lg max-w-lg w-full p-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">Character Details</h2>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
          <X size={24} />
        </button>
      </div>
      
      <div className="mb-6 flex justify-center">
        <BitmapDisplay fontName={fontName} glyph={glyph} size="large" />
      </div>

      <div className="space-y-4">
        <div>
          <h3 className="font-semibold mb-2">Details</h3>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>Character:</div>
            <div className="font-mono">{glyph.char}</div>
            <div>Code Point:</div>
            <div className="font-mono">{glyph.code_point} ({getHexFilename(glyph.code_point)})</div>
            <div>Dimensions:</div>
            <div className="font-mono">{glyph.width}x{glyph.height}</div>
          </div>
        </div>

        <div>
          <h3 className="font-semibold mb-2">JSON</h3>
          <pre className="bg-gray-50 p-3 rounded-lg text-sm font-mono">
            {JSON.stringify(glyph, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  </div>
);

const FontExplorer = () => {
  const [selectedFont, setSelectedFont] = useState<string>('clock-lg');
  const [selectedGlyph, setSelectedGlyph] = useState<Glyph | null>(null);

  const currentFontData = FONTS[selectedFont];

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold mb-2">Font Explorer</h1>
          <div className="flex gap-2 items-center">
            <span>Font:</span>
            <select 
              className="border rounded px-3 py-1"
              value={selectedFont}
              onChange={(e) => setSelectedFont(e.target.value)}
            >
              {Object.keys(FONTS).map(fontName => (
                <option key={fontName} value={fontName}>
                  {fontName}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {currentFontData.glyphs.map((glyph) => (
            <CharacterCard
              key={glyph.code_point}
              fontName={selectedFont}
              glyph={glyph}
              onClick={() => setSelectedGlyph(glyph)}
            />
          ))}
        </div>

        {/* Modal */}
        {selectedGlyph && (
          <DetailModal
            fontName={selectedFont}
            glyph={selectedGlyph}
            onClose={() => setSelectedGlyph(null)}
          />
        )}
      </div>
    </div>
  );
};

export default FontExplorer;