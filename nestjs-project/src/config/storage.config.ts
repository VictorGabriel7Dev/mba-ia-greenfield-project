import { registerAs } from '@nestjs/config';

/**
 * Two endpoints, on purpose.
 *
 * `endpoint` is the Compose service name and is used for every
 * server-to-server call, as the root CLAUDE.md requires.
 *
 * `publicEndpoint` is used only to sign URLs that will be handed to a
 * browser. A URL signed with the internal endpoint resolves only inside the
 * Docker network, and that failure is invisible from the test suite, which
 * also runs inside the network. See ISS-02 in the phase validation.
 */
export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT ||
    process.env.STORAGE_ENDPOINT ||
    'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKey: process.env.STORAGE_ACCESS_KEY || '',
  secretKey: process.env.STORAGE_SECRET_KEY || '',
  videosBucket: process.env.STORAGE_VIDEOS_BUCKET || 'streamtube-videos',
  thumbnailsBucket:
    process.env.STORAGE_THUMBNAILS_BUCKET || 'streamtube-thumbnails',
}));
