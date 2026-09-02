import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';
import type { CompletedPart } from './storage.types';

// S3 rejects any part below 5 MiB except the last one, so a genuine
// multi-part round trip cannot be done with a tiny first part.
const MIN_PART_SIZE = 5 * 1024 * 1024;

async function putPart(url: string, body: Buffer): Promise<string> {
  // Neither `Buffer` nor `Uint8Array<ArrayBufferLike>` satisfies `BodyInit`
  // under this TypeScript configuration, although both are accepted at
  // runtime: since TS 5.7 the typed arrays are generic over their buffer, and
  // the `BufferSource` in the DOM lib is not. Cast at the boundary where the
  // value enters the library API, as `.claude/rules/typescript-strict.md`
  // prescribes, rather than widening the signature of the helper.
  const view = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  const response = await fetch(url, {
    method: 'PUT',
    body: view as unknown as BodyInit,
  });
  if (!response.ok) {
    throw new Error(
      `part upload failed: ${response.status} ${await response.text()}`,
    );
  }
  const etag = response.headers.get('etag');
  if (!etag) {
    throw new Error('storage returned no ETag for the uploaded part');
  }
  return etag;
}

describe('StorageService (integration, real MinIO)', () => {
  let module: TestingModule;
  let service: StorageService;
  let cfg: ConfigType<typeof storageConfig>;
  const keysToClean: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    service = module.get<StorageService>(StorageService);
    cfg = module.get<ConfigType<typeof storageConfig>>(storageConfig.KEY);
  });

  afterAll(async () => {
    await module.close();
  });

  function newKey(): string {
    const key = `integration-tests/${randomUUID()}/source.bin`;
    keysToClean.push(key);
    return key;
  }

  describe('multipart round trip', () => {
    it('reassembles the exact bytes uploaded through presigned part URLs', async () => {
      const key = newKey();
      const first = Buffer.alloc(MIN_PART_SIZE, 'A');
      const second = Buffer.from('the tail part has no minimum size');
      const expected = Buffer.concat([first, second]);

      const uploadId = await service.createMultipartUpload(
        cfg.videosBucket,
        key,
        'application/octet-stream',
      );
      const parts = await service.presignUploadParts(
        cfg.videosBucket,
        key,
        uploadId,
        2,
        3600,
      );
      expect(parts.map((p) => p.partNumber)).toEqual([1, 2]);

      // Uploaded out of order on purpose: the service must sort before
      // completing, and parallel clients genuinely finish out of order.
      const etag2 = await putPart(parts[1].url, second);
      const etag1 = await putPart(parts[0].url, first);

      const completed: CompletedPart[] = [
        { partNumber: 2, etag: etag2 },
        { partNumber: 1, etag: etag1 },
      ];
      await service.completeMultipartUpload(
        cfg.videosBucket,
        key,
        uploadId,
        completed,
      );

      const head = await service.headObject(cfg.videosBucket, key);
      expect(head.contentLength).toBe(expected.length);

      const url = await service.presignGet(cfg.videosBucket, key, 300);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.equals(expected)).toBe(true);
    }, 60_000);
  });

  describe('range requests', () => {
    it('answers a ranged read with 206 and only the requested bytes', async () => {
      const key = newKey();
      const payload = Buffer.alloc(MIN_PART_SIZE, 'R');

      const uploadId = await service.createMultipartUpload(
        cfg.videosBucket,
        key,
        'application/octet-stream',
      );
      const [part] = await service.presignUploadParts(
        cfg.videosBucket,
        key,
        uploadId,
        1,
        3600,
      );
      const etag = await putPart(part.url, payload);
      await service.completeMultipartUpload(cfg.videosBucket, key, uploadId, [
        { partNumber: 1, etag },
      ]);

      const url = await service.presignGet(cfg.videosBucket, key, 300);
      const response = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
      });

      // This is the assertion behind "streaming without downloading the whole
      // file": the range support is the storage layer's, not ours.
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(
        `bytes 0-1023/${payload.length}`,
      );
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.length).toBe(1024);
    }, 60_000);
  });

  describe('abort', () => {
    it('makes the upload id unusable so the parts stop being billed', async () => {
      const key = newKey();
      const uploadId = await service.createMultipartUpload(
        cfg.videosBucket,
        key,
        'application/octet-stream',
      );
      const [part] = await service.presignUploadParts(
        cfg.videosBucket,
        key,
        uploadId,
        1,
        3600,
      );
      const etag = await putPart(part.url, Buffer.alloc(1024, 'X'));

      await service.abortMultipartUpload(cfg.videosBucket, key, uploadId);

      await expect(
        service.completeMultipartUpload(cfg.videosBucket, key, uploadId, [
          { partNumber: 1, etag },
        ]),
      ).rejects.toThrow();
    }, 60_000);
  });

  describe('endpoint separation', () => {
    it('signs client-bound URLs with the public host and server-side URLs with the internal one', async () => {
      const key = 'integration-tests/endpoint-check';

      const publicUrl = await service.presignGet(cfg.videosBucket, key, 300);
      const internalUrl = await service.presignInternalGet(
        cfg.videosBucket,
        key,
        300,
      );

      // Both resolve from inside the Compose network, so behaviour cannot tell
      // them apart. Only the host can, which is why this is asserted at all:
      // a public URL signed with the internal endpoint passes every test here
      // and fails in the browser.
      expect(new URL(publicUrl).host).toBe(new URL(cfg.publicEndpoint).host);
      expect(new URL(internalUrl).host).toBe(new URL(cfg.endpoint).host);
      expect(new URL(publicUrl).host).not.toBe(new URL(internalUrl).host);
    });
  });

  describe('presigned URL expiry', () => {
    it('rejects a read once the TTL has elapsed', async () => {
      const key = newKey();
      const uploadId = await service.createMultipartUpload(
        cfg.videosBucket,
        key,
        'application/octet-stream',
      );
      const [part] = await service.presignUploadParts(
        cfg.videosBucket,
        key,
        uploadId,
        1,
        3600,
      );
      const etag = await putPart(part.url, Buffer.from('expiring'));
      await service.completeMultipartUpload(cfg.videosBucket, key, uploadId, [
        { partNumber: 1, etag },
      ]);

      // 1 second is the smallest TTL that is still a real expiry. If the TTL
      // were being passed as milliseconds, this URL would stay valid and the
      // test would fail, which is the point.
      const url = await service.presignGet(cfg.videosBucket, key, 1);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const response = await fetch(url);

      expect(response.status).toBe(403);
    }, 60_000);
  });
});
