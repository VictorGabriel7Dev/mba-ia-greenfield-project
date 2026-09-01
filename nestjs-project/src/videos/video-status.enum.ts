/**
 * The lifecycle decided in TD-09.
 *
 * `draft` is owned by the client (the upload has been initiated but not
 * finished), `processing` and its two outcomes are owned by the worker. There
 * is deliberately no `uploading` state: bytes go straight to storage, so the
 * backend cannot observe that transition and would have to trust the client
 * for it.
 */
export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}
