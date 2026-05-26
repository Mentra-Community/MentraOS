export type BarcodeBounds = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type BarcodeCornerPoint = {
  x: number;
  y: number;
};

export type BarcodeScanResult = {
  bounds?: BarcodeBounds;
  cornerPoints?: BarcodeCornerPoint[];
  displayValue?: string | null;
  format: string;
  rawValue?: string | null;
  valueType?: string;
};

export type ImageFovEstimate = {
  basis: '35mm_equivalent';
  diagonalDegrees: number;
  focalLength35mm: number;
  horizontalDegrees: number;
  verticalDegrees: number;
};

export type ImageMetadata = {
  estimatedFov?: ImageFovEstimate | null;
  focalLength35mm?: number | null;
  height?: number | null;
  width?: number | null;
};

export type TestBarcodeImage = {
  byteCount: number;
  fileUri: string;
  value: string;
};
