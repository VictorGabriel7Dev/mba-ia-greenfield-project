/** One presigned `UploadPart` URL. Part numbers are 1-based, per the S3 API. */
export interface PresignedPart {
  partNumber: number;
  url: string;
}

/** What the client reports back after uploading a part. */
export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface PresignGetOptions {
  /** Value for `response-content-disposition`, used to force a download. */
  contentDisposition?: string;
}
