/** Queue and job contract. See "Events / Messages" in the phase 03 plan. */
export const VIDEO_QUEUE = 'video-processing' as const;
export const VIDEO_PROCESS_JOB = 'process-video' as const;

export const VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: true,
  // Retained on purpose: the failed set is the dead letter queue. Setting this
  // to `true` would delete the evidence of the failure.
  removeOnFail: false,
} as const;

export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg' as const;
export const THUMBNAIL_FILENAME = 'thumbnail.jpg' as const;
export const SOURCE_BASENAME = 'source' as const;
