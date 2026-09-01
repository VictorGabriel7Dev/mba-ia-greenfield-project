import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/video-status.enum';

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'sample.mp4'));
const FIXTURE_DURATION_SECONDS = 2;
const TEN_GIB = 10_737_418_240;

/** How long the worker gets to turn a completed upload into a ready video. */
const PROCESSING_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

interface UploadInstructions {
  id: string;
  public_id: string;
  status: string;
  upload_id: string;
  part_size_bytes: number;
  parts: { part_number: number; url: string }[];
}

function asBody<T>(body: unknown): T {
  return body as T;
}

async function putBytes(url: string, body: Buffer): Promise<string> {
  const view = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  const response = await fetch(url, {
    method: 'PUT',
    body: view as unknown as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`part upload failed with ${response.status}`);
  }
  const etag = response.headers.get('etag');
  if (!etag) throw new Error('storage returned no ETag');
  return etag;
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let storage: ConfigType<typeof storageConfig>;
  let emailCounter = 0;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Test.createTestingModule does not run main.ts, so the global pipe and
    // filters have to be applied by hand or the error contract differs here.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    storage = moduleFixture.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    );
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    throttlerStorage.storage.clear();
  });

  /**
   * Cleans up **after** each test, and only once nothing is still being
   * processed.
   *
   * Cleaning before each test instead would delete rows while the worker, a
   * separate process in a separate container, is mid-job: it then fails to
   * write back with a foreign-key violation on a channel that no longer
   * exists. That does not necessarily fail the test that caused it, which is
   * what makes it dangerous. It is a race in the harness, not in the product,
   * and waiting is what removes it.
   */
  afterEach(async () => {
    await waitForQuiescence();
    await cleanAllTables(dataSource);
  });

  async function waitForQuiescence(): Promise<void> {
    const deadline = Date.now() + PROCESSING_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const inFlight = await videoRepository.count({
        where: { status: VideoStatus.PROCESSING },
      });
      if (inFlight === 0) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(
      'videos were still being processed when the test finished; cleaning now would race the worker',
    );
  }

  async function login(): Promise<string> {
    const email = `videos_e2e_${++emailCounter}_${Date.now()}@example.com`;
    const password = 'password123';

    const authService = app.get(AuthService);
    const mailService = (authService as unknown as { mailService: object })
      .mailService;
    let confirmationToken = '';
    jest
      .spyOn(mailService as never, 'sendConfirmationEmail')
      .mockImplementationOnce(((_e: string, _n: string, token: string) => {
        confirmationToken = token;
        return Promise.resolve();
      }) as never);

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    return asBody<{ access_token: string }>(response.body).access_token;
  }

  // Not async: returning the supertest Test itself keeps the `.expect()`
  // chain available at the call site.
  function initiate(token: string, overrides: Record<string, unknown> = {}) {
    return request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'A clip',
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: FIXTURE.length,
        ...overrides,
      });
  }

  /** Upload the fixture and complete, leaving the video in `processing`. */
  async function uploadFixture(token: string): Promise<UploadInstructions> {
    const response = await initiate(token).expect(201);
    const instructions = asBody<UploadInstructions>(response.body);

    const etag = await putBytes(instructions.parts[0].url, FIXTURE);

    await request(app.getHttpServer())
      .post(`/videos/${instructions.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ part_number: 1, etag }] })
      .expect(200);

    return instructions;
  }

  /**
   * Waits for the worker, which is a different process in a different
   * container. Asserting the status immediately after completing would be
   * asserting on a race: it would pass for the wrong reason on a slow machine
   * and fail intermittently on a fast one.
   */
  async function waitForStatus(
    videoId: string,
    target: VideoStatus,
  ): Promise<Video> {
    const deadline = Date.now() + PROCESSING_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const video = await videoRepository.findOne({ where: { id: videoId } });
      if (video && video.status === target) return video;
      if (video && video.status === VideoStatus.FAILED) {
        throw new Error(
          `video failed while waiting for ${target}: ${video.processing_error ?? '(no reason recorded)'}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    const last = await videoRepository.findOne({ where: { id: videoId } });
    throw new Error(
      `timed out after ${PROCESSING_TIMEOUT_MS}ms waiting for ${target}; last status was ${last?.status ?? 'missing'}`,
    );
  }

  describe('POST /videos — upload initiation', () => {
    it('pre-registers the video as a draft before a single byte is uploaded', async () => {
      const token = await login();

      const response = await initiate(token).expect(201);
      const body = asBody<UploadInstructions>(response.body);

      expect(body.status).toBe(VideoStatus.DRAFT);
      expect(body.public_id).toMatch(/^[A-Za-z0-9_-]{12}$/);
      expect(body.upload_id).toBeTruthy();

      const persisted = await videoRepository.findOne({
        where: { id: body.id },
      });
      expect(persisted?.status).toBe(VideoStatus.DRAFT);
    }, 30_000);

    it('serves a 10GB upload as 103 presigned parts without moving any bytes', async () => {
      // This is how the 10GB requirement is verified without transferring
      // 10GB: what the requirement actually constrains is the part
      // arithmetic, and that is asserted directly.
      const token = await login();

      const response = await initiate(token, {
        size_bytes: TEN_GIB,
      }).expect(201);
      const body = asBody<UploadInstructions>(response.body);

      expect(body.part_size_bytes).toBe(104_857_600);
      expect(body.parts).toHaveLength(103);
      expect(body.parts[0].part_number).toBe(1);
      expect(body.parts[102].part_number).toBe(103);
      expect(body.parts.length).toBeLessThan(10_000);

      // Release the parts storage is now holding for an upload nobody will
      // finish: an initiated multipart upload never expires on its own.
      await request(app.getHttpServer())
        .post(`/videos/${body.id}/abort`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
    }, 60_000);

    it('rejects a file above the maximum size', async () => {
      const token = await login();

      const response = await initiate(token, {
        size_bytes: TEN_GIB + 1,
      }).expect(400);

      expect(asBody<{ error: string }>(response.body).error).toBe(
        'FILE_TOO_LARGE',
      );
    }, 30_000);

    it('rejects a content type outside the allowlist', async () => {
      const token = await login();

      const response = await initiate(token, {
        content_type: 'application/zip',
      }).expect(400);

      expect(asBody<{ error: string }>(response.body).error).toBe(
        'UNSUPPORTED_CONTENT_TYPE',
      );
    }, 30_000);

    it('refuses an anonymous caller', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          title: 'A clip',
          filename: 'clip.mp4',
          content_type: 'video/mp4',
          size_bytes: 1024,
        })
        .expect(401);
    }, 30_000);
  });

  describe('the full pipeline, against the real worker container', () => {
    it('takes an uploaded file all the way to ready, with duration and thumbnail', async () => {
      const token = await login();
      const instructions = await uploadFixture(token);

      const video = await waitForStatus(instructions.id, VideoStatus.READY);

      expect(video.duration_seconds).toBeCloseTo(FIXTURE_DURATION_SECONDS, 0);
      expect(video.thumbnail_key).not.toBeNull();
      expect(video.metadata?.width).toBe(320);
      expect(video.metadata?.height).toBe(240);
      expect(video.metadata?.videoCodec).toBe('h264');
      expect(video.processing_error).toBeNull();
      // The size persisted is the one storage measured, not the declared one.
      expect(video.size_bytes).toBe(FIXTURE.length);
    }, 120_000);

    it('stores a thumbnail that is a real, non-empty JPEG', async () => {
      // Non-emptiness is the assertion that matters: a frame cut past the end
      // of the video comes back with exit code 0 and zero bytes, and every
      // status check would still say the video is ready.
      const token = await login();
      const instructions = await uploadFixture(token);
      await waitForStatus(instructions.id, VideoStatus.READY);

      const redirect = await request(app.getHttpServer())
        .get(`/videos/${instructions.public_id}/thumbnail`)
        .expect(302);

      const response = await fetch(redirect.headers.location as string);
      expect(response.status).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());

      expect(bytes.length).toBeGreaterThan(0);
      // JPEG SOI marker.
      expect(bytes[0]).toBe(0xff);
      expect(bytes[1]).toBe(0xd8);
    }, 120_000);
  });

  describe('completion and abort', () => {
    it('moves the video to processing and records the measured size', async () => {
      const token = await login();
      const response = await initiate(token).expect(201);
      const instructions = asBody<UploadInstructions>(response.body);
      const etag = await putBytes(instructions.parts[0].url, FIXTURE);

      const completion = await request(app.getHttpServer())
        .post(`/videos/${instructions.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(200);

      const body = asBody<{ status: string; size_bytes: number }>(
        completion.body,
      );
      expect(body.size_bytes).toBe(FIXTURE.length);
      expect([VideoStatus.PROCESSING, VideoStatus.READY]).toContain(
        body.status,
      );
    }, 60_000);

    it('rejects completing the same upload twice', async () => {
      const token = await login();
      const instructions = await uploadFixture(token);

      const response = await request(app.getHttpServer())
        .post(`/videos/${instructions.id}/complete`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parts: [{ part_number: 1, etag: '"whatever"' }] })
        .expect(409);

      expect(asBody<{ error: string }>(response.body).error).toBe(
        'INVALID_VIDEO_STATE',
      );
    }, 60_000);

    it('refuses completion by a different user', async () => {
      const owner = await login();
      const stranger = await login();
      const response = await initiate(owner).expect(201);
      const instructions = asBody<UploadInstructions>(response.body);

      const forbidden = await request(app.getHttpServer())
        .post(`/videos/${instructions.id}/complete`)
        .set('Authorization', `Bearer ${stranger}`)
        .send({ parts: [{ part_number: 1, etag: '"x"' }] })
        .expect(403);

      expect(asBody<{ error: string }>(forbidden.body).error).toBe(
        'VIDEO_NOT_OWNED',
      );
      const persisted = await videoRepository.findOne({
        where: { id: instructions.id },
      });
      expect(persisted?.status).toBe(VideoStatus.DRAFT);
    }, 60_000);
  });

  describe('GET /videos/:id/status', () => {
    it('lets the owner poll while the video is not public yet', async () => {
      const token = await login();
      const response = await initiate(token).expect(201);
      const instructions = asBody<UploadInstructions>(response.body);

      const status = await request(app.getHttpServer())
        .get(`/videos/${instructions.id}/status`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(asBody<{ status: string }>(status.body).status).toBe(
        VideoStatus.DRAFT,
      );
    }, 30_000);

    it('refuses an anonymous caller and another user', async () => {
      const owner = await login();
      const stranger = await login();
      const response = await initiate(owner).expect(201);
      const instructions = asBody<UploadInstructions>(response.body);

      await request(app.getHttpServer())
        .get(`/videos/${instructions.id}/status`)
        .expect(401);

      await request(app.getHttpServer())
        .get(`/videos/${instructions.id}/status`)
        .set('Authorization', `Bearer ${stranger}`)
        .expect(403);
    }, 60_000);
  });

  describe('public read', () => {
    it('hides a video that is not ready behind the same 404 as an unknown one', async () => {
      const token = await login();
      const response = await initiate(token).expect(201);
      const instructions = asBody<UploadInstructions>(response.body);

      const draft = await request(app.getHttpServer())
        .get(`/videos/${instructions.public_id}`)
        .expect(404);
      const unknown = await request(app.getHttpServer())
        .get('/videos/doesnotexist')
        .expect(404);

      // Identical responses: otherwise a draft can be detected by probing.
      expect(asBody<{ error: string }>(draft.body).error).toBe(
        'VIDEO_NOT_FOUND',
      );
      expect(asBody<{ error: string }>(unknown.body).error).toBe(
        'VIDEO_NOT_FOUND',
      );
    }, 30_000);

    it('serves a ready video anonymously with its channel', async () => {
      const token = await login();
      const instructions = await uploadFixture(token);
      await waitForStatus(instructions.id, VideoStatus.READY);

      const response = await request(app.getHttpServer())
        .get(`/videos/${instructions.public_id}`)
        .expect(200);

      const body = asBody<{
        public_id: string;
        title: string;
        duration_seconds: number;
        channel: { nickname: string };
      }>(response.body);
      expect(body.public_id).toBe(instructions.public_id);
      expect(body.title).toBe('A clip');
      expect(body.duration_seconds).toBeCloseTo(FIXTURE_DURATION_SECONDS, 0);
      expect(body.channel.nickname).toBeTruthy();
    }, 120_000);
  });

  describe('streaming and download', () => {
    it('redirects to the public storage host, not the internal one', async () => {
      const token = await login();
      const instructions = await uploadFixture(token);
      await waitForStatus(instructions.id, VideoStatus.READY);

      const redirect = await request(app.getHttpServer())
        .get(`/videos/${instructions.public_id}/stream`)
        .expect(302);

      const location = new URL(redirect.headers.location as string);
      // Both hosts resolve from inside the Compose network, so behaviour
      // cannot tell them apart. Only the host can.
      expect(location.host).toBe(new URL(storage.publicEndpoint).host);
      expect(location.host).not.toBe(new URL(storage.endpoint).host);
    }, 120_000);

    it('serves a byte range with 206, so playback does not need the whole file', async () => {
      const token = await login();
      const instructions = await uploadFixture(token);
      await waitForStatus(instructions.id, VideoStatus.READY);

      const redirect = await request(app.getHttpServer())
        .get(`/videos/${instructions.public_id}/stream`)
        .expect(302);

      const response = await fetch(redirect.headers.location as string, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(
        `bytes 0-1023/${FIXTURE.length}`,
      );
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.length).toBe(1024);
      expect(bytes.equals(FIXTURE.subarray(0, 1024))).toBe(true);
    }, 120_000);

    it('offers the download as an attachment under the original filename', async () => {
      const token = await login();
      const instructions = await uploadFixture(token);
      await waitForStatus(instructions.id, VideoStatus.READY);

      const redirect = await request(app.getHttpServer())
        .get(`/videos/${instructions.public_id}/download`)
        .expect(302);

      const location = new URL(redirect.headers.location as string);
      const disposition = location.searchParams.get(
        'response-content-disposition',
      );
      expect(disposition).toBe('attachment; filename="clip.mp4"');

      const response = await fetch(location.toString());
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain(
        'attachment',
      );
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.equals(FIXTURE)).toBe(true);
    }, 120_000);

    it('refuses to stream a video that is not ready', async () => {
      const token = await login();
      const response = await initiate(token).expect(201);
      const instructions = asBody<UploadInstructions>(response.body);

      await request(app.getHttpServer())
        .get(`/videos/${instructions.public_id}/stream`)
        .expect(404);
    }, 30_000);
  });
});
