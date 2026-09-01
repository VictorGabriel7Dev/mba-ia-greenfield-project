import { Test, TestingModule } from '@nestjs/testing';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { STORAGE_CLIENTS } from './storage.constants';
import { StorageService } from './storage.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const mockedGetSignedUrl = getSignedUrl as unknown as jest.Mock;

const BUCKET = 'streamtube-videos';
const KEY = 'channels/c1/videos/v1/source.mp4';
const UPLOAD_ID = 'upload-123';

describe('StorageService', () => {
  let service: StorageService;
  let internalClient: { send: jest.Mock };
  let publicClient: { send: jest.Mock };

  beforeEach(async () => {
    internalClient = { send: jest.fn() };
    publicClient = { send: jest.fn() };
    mockedGetSignedUrl.mockReset();
    mockedGetSignedUrl.mockResolvedValue('https://signed.example/url');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: STORAGE_CLIENTS.INTERNAL, useValue: internalClient },
        { provide: STORAGE_CLIENTS.PUBLIC, useValue: publicClient },
      ],
    }).compile();

    service = module.get<StorageService>(StorageService);
  });

  describe('createMultipartUpload', () => {
    it('returns the UploadId reported by storage', async () => {
      internalClient.send.mockResolvedValue({ UploadId: UPLOAD_ID });

      const result = await service.createMultipartUpload(
        BUCKET,
        KEY,
        'video/mp4',
      );

      expect(result).toBe(UPLOAD_ID);
      const command = internalClient.send.mock.calls[0][0] as unknown;
      expect(command).toBeInstanceOf(CreateMultipartUploadCommand);
    });

    it('throws when storage returns no UploadId instead of returning undefined', async () => {
      // A missing UploadId would otherwise be persisted as undefined and only
      // fail much later, when the client tries to complete the upload.
      internalClient.send.mockResolvedValue({});

      await expect(
        service.createMultipartUpload(BUCKET, KEY, 'video/mp4'),
      ).rejects.toThrow(/UploadId/);
    });
  });

  describe('presignUploadParts', () => {
    it('produces one URL per part, numbered from 1 and contiguous', async () => {
      const parts = await service.presignUploadParts(
        BUCKET,
        KEY,
        UPLOAD_ID,
        4,
        3600,
      );

      expect(parts).toHaveLength(4);
      expect(parts.map((p) => p.partNumber)).toEqual([1, 2, 3, 4]);
    });

    it('signs part URLs with the public client, since the browser uploads them', async () => {
      await service.presignUploadParts(BUCKET, KEY, UPLOAD_ID, 2, 3600);

      for (const call of mockedGetSignedUrl.mock.calls) {
        expect(call[0]).toBe(publicClient);
        expect(call[1]).toBeInstanceOf(UploadPartCommand);
      }
    });

    it('passes the TTL as seconds', async () => {
      await service.presignUploadParts(BUCKET, KEY, UPLOAD_ID, 1, 3600);

      expect(mockedGetSignedUrl.mock.calls[0][2]).toEqual({ expiresIn: 3600 });
    });

    it('returns an empty list for zero parts rather than a single URL', async () => {
      const parts = await service.presignUploadParts(
        BUCKET,
        KEY,
        UPLOAD_ID,
        0,
        3600,
      );

      expect(parts).toEqual([]);
      expect(mockedGetSignedUrl).not.toHaveBeenCalled();
    });
  });

  describe('completeMultipartUpload', () => {
    it('sorts parts by ascending part number before sending', async () => {
      internalClient.send.mockResolvedValue({});

      await service.completeMultipartUpload(BUCKET, KEY, UPLOAD_ID, [
        { partNumber: 3, etag: 'c' },
        { partNumber: 1, etag: 'a' },
        { partNumber: 2, etag: 'b' },
      ]);

      const command = internalClient.send.mock.calls[0][0] as {
        input: { MultipartUpload: { Parts: { PartNumber: number }[] } };
      };
      expect(command).toBeInstanceOf(CompleteMultipartUploadCommand);
      expect(
        command.input.MultipartUpload.Parts.map((p) => p.PartNumber),
      ).toEqual([1, 2, 3]);
    });

    it('does not mutate the caller array while sorting', async () => {
      internalClient.send.mockResolvedValue({});
      const parts = [
        { partNumber: 2, etag: 'b' },
        { partNumber: 1, etag: 'a' },
      ];

      await service.completeMultipartUpload(BUCKET, KEY, UPLOAD_ID, parts);

      expect(parts.map((p) => p.partNumber)).toEqual([2, 1]);
    });
  });

  describe('abortMultipartUpload', () => {
    it('sends an AbortMultipartUploadCommand with the upload id', async () => {
      internalClient.send.mockResolvedValue({});

      await service.abortMultipartUpload(BUCKET, KEY, UPLOAD_ID);

      const command = internalClient.send.mock.calls[0][0] as {
        input: { UploadId: string };
      };
      expect(command).toBeInstanceOf(AbortMultipartUploadCommand);
      expect(command.input.UploadId).toBe(UPLOAD_ID);
    });
  });

  describe('presignGet vs presignInternalGet', () => {
    it('signs a client-bound read with the public client', async () => {
      await service.presignGet(BUCKET, KEY, 900);

      expect(mockedGetSignedUrl.mock.calls[0][0]).toBe(publicClient);
      expect(mockedGetSignedUrl.mock.calls[0][1]).toBeInstanceOf(
        GetObjectCommand,
      );
    });

    it('signs a server-side read with the internal client', async () => {
      // The two are easy to swap and both work from inside the Compose
      // network, so only an explicit assertion separates them.
      await service.presignInternalGet(BUCKET, KEY, 7200);

      expect(mockedGetSignedUrl.mock.calls[0][0]).toBe(internalClient);
    });

    it('sets response-content-disposition when a download is requested', async () => {
      await service.presignGet(BUCKET, KEY, 900, {
        contentDisposition: 'attachment; filename="clip.mp4"',
      });

      const command = mockedGetSignedUrl.mock.calls[0][1] as {
        input: { ResponseContentDisposition?: string };
      };
      expect(command.input.ResponseContentDisposition).toBe(
        'attachment; filename="clip.mp4"',
      );
    });

    it('omits response-content-disposition when not requested', async () => {
      await service.presignGet(BUCKET, KEY, 900);

      const command = mockedGetSignedUrl.mock.calls[0][1] as {
        input: { ResponseContentDisposition?: string };
      };
      expect(command.input.ResponseContentDisposition).toBeUndefined();
    });
  });

  describe('putObject and headObject', () => {
    it('writes small objects through the internal client', async () => {
      internalClient.send.mockResolvedValue({});

      await service.putObject(
        'streamtube-thumbnails',
        'thumb.jpg',
        Buffer.from('data'),
        'image/jpeg',
      );

      expect(internalClient.send.mock.calls[0][0]).toBeInstanceOf(
        PutObjectCommand,
      );
    });

    it('reports the content length from HeadObject', async () => {
      internalClient.send.mockResolvedValue({ ContentLength: 10737418240 });

      const result = await service.headObject(BUCKET, KEY);

      expect(internalClient.send.mock.calls[0][0]).toBeInstanceOf(
        HeadObjectCommand,
      );
      expect(result.contentLength).toBe(10737418240);
    });

    it('reports zero rather than undefined when ContentLength is absent', async () => {
      internalClient.send.mockResolvedValue({});

      const result = await service.headObject(BUCKET, KEY);

      expect(result.contentLength).toBe(0);
    });
  });
});
