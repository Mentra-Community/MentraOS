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

export type TestBarcodeImage = {
  byteCount: number;
  fileUri: string;
  value: string;
};
