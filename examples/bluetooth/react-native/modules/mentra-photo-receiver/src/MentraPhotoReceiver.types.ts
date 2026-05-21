export type PhotoReceiverUploadEvent = {
  byteCount: number;
  fileUri: string;
  requestId?: string | null;
};

export type PhotoReceiverStatusEvent = {
  message: string;
};

export type PhotoReceiverResult = {
  host: string;
  port: number;
  uploadUrl: string;
};

export type MentraPhotoReceiverModuleEvents = {
  photoUpload: (event: PhotoReceiverUploadEvent) => void;
  receiverStatus: (event: PhotoReceiverStatusEvent) => void;
};
