---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-01T01:18:03-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-01T17:53:55-03:00"
  docs/phases/phase-03-videos/context.md: "2026-09-01T17:56:32-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-09-01T01:18:03-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver ingestion of large video files end to end: a draft video pre-registered the moment an upload starts, up to 10GB uploaded straight to object storage without a byte crossing the API, automatic background processing that extracts duration and metadata and cuts a thumbnail, a short unique public URL per video, and playback by streaming plus download, both served by storage rather than by the API.

This is the first phase to add stateful infrastructure beyond the database: object storage, a processing queue, and a worker process that is not the API.

---

## Step Implementations

### SI-03.1 — Dependencies, Configuration Namespaces, and Storage/Queue Infrastructure

**Description:** Install the phase dependencies, create the `storage`, `queue` and `video` config namespaces following the `registerAs` pattern inherited from Fase 01, extend the Joi schema, and add MinIO and Redis to Docker Compose with the bucket bootstrap. Also fix the `.env.example` defect recorded as ISS-08, which blocks `docker compose up` for anyone starting from the documented steps.

**Technical actions:**

- Install production dependencies: `@nestjs/bullmq@^12.0.0`, `bullmq@^6.3.4`, `@aws-sdk/client-s3@^3.1124.0`, `@aws-sdk/s3-request-presigner@^3.1124.0`
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (internal, Compose service name), `STORAGE_PUBLIC_ENDPOINT` (used only to sign browser-bound URLs, see ISS-02), `STORAGE_REGION`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_VIDEOS_BUCKET`, `STORAGE_THUMBNAILS_BUCKET`
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `QUEUE_HOST` (default `redis`), `QUEUE_PORT` (default `6379`)
- Create `src/config/video.config.ts` — `registerAs('video', ...)` reading `VIDEO_MAX_SIZE_BYTES` (default `10737418240`, exactly 10 GiB), `VIDEO_UPLOAD_PART_SIZE_BYTES` (default `104857600`, 100 MiB), `VIDEO_UPLOAD_URL_TTL_SECONDS` (default `3600`), `VIDEO_PLAYBACK_URL_TTL_SECONDS` (default `900`), `VIDEO_ALLOWED_CONTENT_TYPES` (comma-separated)
- Update `src/config/env.validation.ts` — add every new variable to the Joi schema. `STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY` are `required()`, matching how `JWT_SECRET` is treated: a missing credential must stop the boot, not surface as a storage error on the first upload
- Update `.env.example` with all new variables and Compose-compatible defaults, and **fix `MAIL_FROM`** to the quoted form `"StreamTube <noreply@streamtube.local>"` prescribed by `nestjs-project/CLAUDE.md` (ISS-08)
- Add `minio` to `nestjs-project/compose.yaml` — image `minio/minio`, command `server /data --console-address ":9001"`, healthcheck on `/minio/health/live`, named volume for `/data`
- Add `minio-init` to Compose — a short-lived `minio/mc` container that waits for MinIO to be healthy and creates both buckets idempotently (`mc mb --ignore-existing`). Bucket creation belongs to infrastructure, not to application boot: an API that creates its own buckets needs write-admin credentials it should not hold
- Add `redis` to Compose — image `redis:8-alpine`, healthcheck `redis-cli ping`, named volume
- Make `nestjs-api` depend on `minio` and `redis` with `condition: service_healthy`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/env.validation.integration-spec.ts` (extended) | Integration | Boot fails when `STORAGE_ACCESS_KEY` or `STORAGE_SECRET_KEY` is absent; numeric defaults are coerced from strings |

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` starts `nestjs-api`, `db`, `mailpit`, `minio` and `redis`, and every service reports `running`
- `docker compose ps` shows `minio` and `redis` as `healthy`
- Both buckets exist after `minio-init` completes, and re-running it does not fail
- Copying `.env.example` to `.env` and running `docker compose up -d` works with no manual edit
- Starting the application without `STORAGE_ACCESS_KEY` produces a Joi validation error at bootstrap and the app does not start

---

### SI-03.2 — Storage Module: S3 Client, Presigning, Multipart

**Description:** Create the storage module that owns every interaction with object storage. It exposes multipart initiation, per-part presigned URLs, completion, abort, presigned reads and small-object writes. It is the only place in the codebase that knows the S3 API exists.

**Technical actions:**

- Create `src/storage/storage.constants.ts` — DI tokens `STORAGE_INTERNAL_CLIENT` and `STORAGE_PUBLIC_CLIENT`, `as const`
- Create `src/storage/storage.module.ts` — provides two `S3Client` instances via factory providers. Both take `forcePathStyle: true`, required for MinIO; they differ only in `endpoint`. Exports `StorageService`
- Create `src/storage/storage.service.ts` with:
  - `createMultipartUpload(bucket, key, contentType): Promise<string>` returning the `uploadId`
  - `presignUploadParts(bucket, key, uploadId, partCount, ttl): Promise<PresignedPart[]>` where `PresignedPart` is `{ partNumber: number; url: string }`, part numbers starting at 1
  - `completeMultipartUpload(bucket, key, uploadId, parts): Promise<void>` with parts sorted ascending by `partNumber` before the call
  - `abortMultipartUpload(bucket, key, uploadId): Promise<void>`
  - `presignGet(bucket, key, ttl, options?): Promise<string>` signed with the **public** client, with optional `ResponseContentDisposition`
  - `presignInternalGet(bucket, key, ttl): Promise<string>` signed with the **internal** client, used only for the URL handed to FFmpeg (TD-05)
  - `putObject(bucket, key, body, contentType): Promise<void>` for thumbnails
  - `headObject(bucket, key): Promise<{ contentLength: number }>`
- Create `src/storage/storage.types.ts` for `PresignedPart` and `CompletedPart`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.spec.ts` | Unit | Part numbers start at 1 and are contiguous; parts are sorted before `CompleteMultipartUpload`; `presignGet` uses the public client and `presignInternalGet` the internal one; `expiresIn` is passed in **seconds** |
| `src/storage/storage.service.integration-spec.ts` | Integration | Against the real MinIO: full multipart round trip (create, presign, `PUT` each part, complete) reproduces the exact bytes; abort makes the `uploadId` unusable; a presigned `GET` honours `Range` and answers `206` with a correct `Content-Range` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- A file uploaded through presigned part URLs and completed is byte-identical when read back
- A ranged request against a presigned `GET` returns `206` with `Content-Range` and only the requested bytes
- After `abortMultipartUpload`, completing the same `uploadId` fails
- The URL returned by `presignGet` contains the public endpoint host, and the one from `presignInternalGet` contains the internal one. This is asserted explicitly because both work from inside the test container, so only an assertion on the host can tell them apart

---

### SI-03.3 — Video Entity, Status Enum, and Migration

**Description:** Create the `Video` entity owned by a channel, with the status lifecycle of TD-09, the storage keys, the metadata columns and the unique public identifier. Generate the migration.

**Technical actions:**

- Create `src/videos/video-status.enum.ts` — `VideoStatus` with `DRAFT`, `PROCESSING`, `READY`, `FAILED`
- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with the columns in the Data Model below. `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`, and the matching `@OneToMany` on `Channel`
- `size_bytes` uses `type: 'bigint'` **with a transformer to `number`**. TypeORM returns `bigint` columns as strings, so without the transformer `size_bytes` silently becomes a string and every arithmetic comparison against it is a string comparison that still "works" for some values
- Create `src/videos/videos.module.ts` with `TypeOrmModule.forFeature([Video])`, and add `VideosModule` to `AppModule`. Registering the entity in `forFeature` is mandatory: with `autoLoadEntities` alone the entity is silently invisible
- Generate the migration with `npm run migration:generate -- src/database/migrations/CreateVideos` and review the SQL
- Update `src/test/create-test-data-source.ts` — add `DELETE FROM "videos"` to `cleanAllTables`, **before** `channels` (ISS-05)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique `public_id` constraint; FK to `channels`; `status` defaults to `draft`; the enum rejects an unknown value; nullable columns accept null; `size_bytes` round-trips a value above 2^32 as a **number**, not a string |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with the `forFeature` wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with all columns, the enum type, the unique index on `public_id` and the FK to `channels`
- Inserting two videos with the same `public_id` fails with a unique violation
- A video inserted without a status has `status = 'draft'`
- Reading back `size_bytes = 10737418240` yields the JavaScript number `10737418240`
- `cleanAllTables` no longer raises a foreign-key violation when videos exist

---

### SI-03.4 — Migration Spec: Fix the Enum Leak and Cover the New Migration

**Description:** Correct the pre-existing defect recorded as ISS-04 and extend the spec for the third migration (ISS-03). This is a correction step in the spirit of SI-02.14 and SI-02.17: it does not add product behaviour, and it has its own step because it touches a Fase 02 file for a reason of its own.

**Technical actions:**

- In `src/database/migrations.integration-spec.ts` `beforeAll`, drop the enum types alongside the tables: `DROP TYPE IF EXISTS "verification_tokens_type_enum"` and `DROP TYPE IF EXISTS "videos_status_enum"`. `DROP TABLE ... CASCADE` does not remove an enum type, which is the whole defect
- Add `videos` to `MANAGED_TABLES` and the `CreateVideos` class to the `migrations` array, imported directly rather than by glob, per `.claude/rules/typeorm-migrations.md`
- Update the count assertion from 2 to 3 migrations and the expected table list
- The migration is not edited. `.claude/rules/typeorm-migrations.md` forbids editing an executed migration, and PostgreSQL has no `CREATE TYPE IF NOT EXISTS` that would make `up()` idempotent, so the incomplete cleanup in the test is both the cause and the correct place to fix

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/database/migrations.integration-spec.ts` (fixed and extended) | Integration | All three migrations apply on a database that was **already migrated**, which is the case that fails today; the reverted migration removes the token tables; `afterAll` restores the schema |

**Dependencies:** SI-03.3

**Acceptance criteria:**

- Running the spec twice in a row passes both times. This is the regression that reproduces the defect: today the first run passes and the second fails with `type "verification_tokens_type_enum" already exists`
- The full unit and integration suite passes on a database prepared by the sequence documented in `nestjs-project/CLAUDE.md` (`docker compose up -d`, then `npm run migration:run`)

---

### SI-03.5 — Channel Lookup by Owner

**Description:** Add the read method the videos module needs to resolve "the channel of this user" (ISS-06, ISS-07), keeping the `Channel` entity owned by its own module.

**Technical actions:**

- Add `findByUserId(userId: string): Promise<Channel | null>` to `ChannelsService`, injecting `Repository<Channel>` alongside the existing `DataSource`
- The videos module imports `ChannelsModule`, which already exports `ChannelsService`. No repository of another domain is injected into the videos service, per the Single Responsibility principle in the root `CLAUDE.md`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/channels/channels.service.spec.ts` (extended) | Unit | Returns the channel for a known user; returns `null` for an unknown one |
| `src/channels/channels.service.integration-spec.ts` (extended) | Integration | Resolves the channel created automatically at registration |

**Dependencies:** SI-03.3

**Acceptance criteria:**

- `findByUserId` returns the channel created for a registered user
- `findByUserId` returns `null`, not a thrown error, when the user has no channel. Absence is a valid domain result here; converting it into an exception is the caller's decision

---

### SI-03.6 — Public Identifier Generator

**Description:** Implement the short unique public identifier of TD-07, mirroring the shape of the existing `nickname.util.ts`.

**Technical actions:**

- Create `src/videos/public-id.util.ts` — `generatePublicId(): string` returning `randomBytes(9).toString('base64url')`, which is exactly 12 URL-safe characters carrying 72 bits of entropy
- Collision handling belongs to the service, not the generator: insert, and on a unique violation on `public_id` regenerate and retry, bounded. The database constraint is the guarantee; the generator is only a source of candidates

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/public-id.util.spec.ts` | Unit | Always 12 characters; only `[A-Za-z0-9_-]`; no `+`, `/` or `=` from standard base64, which would break the URL; 10000 draws produce no duplicate |

**Dependencies:** None

**Acceptance criteria:**

- The identifier is 12 characters and URL-safe with no escaping
- The alphabet assertion is explicit, because a `base64` encoding instead of `base64url` still produces a plausible 12-character string and only fails later, in routing

---

### SI-03.7 — Upload Initiation with Draft Pre-Registration

**Description:** `POST /videos` creates the video row as `draft`, allocates its `public_id` and its storage key, opens the multipart upload, and returns one presigned URL per part. This is the capability *"pré-cadastro automático do vídeo como rascunho ao iniciar o upload"*.

**Technical actions:**

- Create `src/videos/dto/create-video.dto.ts` — `title` (string, 1..255), `filename` (string, 1..255), `content_type` (string, allowlisted), `size_bytes` (number, positive, `<= VIDEO_MAX_SIZE_BYTES`). Validation via `class-validator` only, letting the Swagger CLI plugin infer the schema, per `.claude/rules/nestjs-dtos.md`
- Create `src/videos/dto/upload-instructions.response.dto.ts` — a response DTO, so every field needs an explicit `@ApiProperty` (the plugin has nothing to introspect on unvalidated shapes)
- Create `src/videos/videos.service.ts` — `initiateUpload(userId, dto)`:
  1. resolve the channel via `ChannelsService.findByUserId`; throw `ChannelNotFoundException` if absent
  2. compute `partCount = ceil(size_bytes / partSize)`
  3. generate `public_id`, build `storage_key` as `channels/<channel_id>/videos/<video_id>/source<ext>`
  4. `createMultipartUpload`, persist the row as `draft` with the `upload_id`
  5. presign the parts and return them
- Create `src/videos/videos.controller.ts` — `@ApiTags('videos')`, `@Controller('videos')`, `POST /` with `@ApiBearerAuth('access-token')` (no `@Public()`), `@HttpCode(201)`, and one `@ApiResponse` per predictable status referencing `getSchemaPath(ApiErrorEnvelope)` for errors
- Add the new domain exceptions to `src/common/exceptions/domain.exception.ts`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `partCount` boundaries: a size exactly one part, one byte over, and exactly `VIDEO_MAX_SIZE_BYTES`; a declared 10 GiB with a 100 MiB part size yields 103 parts and stays under the 10000-part ceiling; rejects a size above the maximum; rejects a content type outside the allowlist |
| `src/videos/videos.service.integration-spec.ts` | Integration | The row is persisted as `draft` with a non-null `upload_id` and a `public_id`; the key contains the real channel and video ids |
| `test/videos.e2e-spec.ts` | E2E | 201 with the expected body; 401 without a token; 400 for a size above the maximum and for a disallowed content type |

**Dependencies:** SI-03.2, SI-03.3, SI-03.5, SI-03.6

**Acceptance criteria:**

- A `POST /videos` declaring `size_bytes = 10737418240` returns 103 presigned part URLs and does not move a single byte through the API. This is how the 10GB requirement is verified without transferring 10GB: the part arithmetic is the requirement, and it is asserted directly
- The video exists in the database with `status = 'draft'` immediately after the call, before any byte is uploaded
- Two videos created in sequence have different `public_id` values and different storage keys
- A request without a bearer token returns 401, since the global guard protects the route by default

---

### SI-03.8 — Upload Completion, Abort, and Job Enqueue

**Description:** `POST /videos/:id/complete` finishes the multipart upload in storage, moves the video to `processing` and enqueues the processing job. `POST /videos/:id/abort` cancels an upload that will not finish, releasing the parts storage holds.

**Technical actions:**

- Register the queue: `BullModule.forRootAsync` in `AppModule` (connection from `queueConfig`, host is the Compose service name) and `BullModule.registerQueue({ name: 'video-processing' })` in `VideosModule`
- Create `src/videos/videos.constants.ts` — `VIDEO_QUEUE`, `VIDEO_PROCESS_JOB`, and the job options block, `as const`
- `completeUpload(userId, videoId, parts)`:
  1. load the video, verify ownership against the user's channel, verify `status === draft` and `upload_id` present
  2. `completeMultipartUpload`
  3. `headObject` to record the **real** `size_bytes` reported by storage, replacing the client-declared value. The declared size was a claim; this is a measurement
  4. transition to `processing`, clear `upload_id`
  5. enqueue `process-video` with `{ videoId }`, `jobId: videoId`, `attempts: 3`, exponential backoff 30s, `removeOnComplete: true`, `removeOnFail: false`
- `abortUpload(userId, videoId)`: ownership and state checks, `abortMultipartUpload`, clear `upload_id`, leave the row as `draft`. Nothing is hard-deleted; the row is Fase 04's to manage
- Controller: `POST :id/complete` (200) and `POST :id/abort` (204), both authenticated, both fully annotated

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` (extended) | Unit | Ownership rejection; completing a non-`draft` video throws `InvalidVideoStateException`; the enqueue call carries `jobId === videoId` and the documented retry options; `size_bytes` is overwritten with the value from `headObject` |
| `src/videos/videos.service.integration-spec.ts` (extended) | Integration | Against real MinIO and real Redis: after completion the object exists with the uploaded bytes, the row is `processing`, and exactly one job sits in the queue with the expected payload |
| `test/videos.e2e-spec.ts` (extended) | E2E | Full multipart round trip with a real fixture; 403 when another user completes; 409 when completing twice |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- A real file uploaded via the presigned part URLs and completed exists in the videos bucket with identical bytes
- The video is `processing` and exactly one job is enqueued, with `jobId` equal to the video id
- Completing the same video a second time returns 409 and does not enqueue a second job
- Another user's completion attempt returns 403 and changes nothing
- After an abort, the parts are released and completing that `uploadId` fails

---

### SI-03.9 — FFmpeg Service: Metadata and Thumbnail

**Description:** Wrap `ffprobe` and `ffmpeg` as decided in TD-06, including explicit handling of the two failure modes that otherwise succeed silently.

**Technical actions:**

- Create `src/videos/ffmpeg.service.ts`:
  - `probe(inputUrl): Promise<VideoMetadata>` running `ffprobe -v error -print_format json -show_format -show_streams <url>`, parsing stdout, and extracting `durationSeconds`, `width`, `height`, `videoCodec`, `audioCodec`, `bitRate`
  - `extractThumbnail(inputUrl, atSeconds): Promise<Buffer>` running `ffmpeg -v error -ss <t> -i <url> -frames:v 1 -f image2 -vcodec mjpeg -` and collecting stdout
  - `thumbnailTimestamp(durationSeconds): number` deriving the frame position as a fraction of the duration, clamped so it can never land at or past the end
- Both methods reject on a non-zero exit **and** on an empty stdout with exit 0. An empty probe result is a failure, not empty metadata; an empty frame is a failure, not a blank thumbnail
- `spawn` is used with an argument array, never a shell string, so a filename can never be interpreted as shell syntax
- A timeout kills the child process, so a stalled remote read cannot hold a worker slot forever

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/ffmpeg.service.spec.ts` | Unit | With `child_process.spawn` mocked: the exact argv of both commands, including `-ss` **before** `-i`; exit 0 with empty stdout throws; non-zero exit throws with stderr in the message; the timeout kills the child; `thumbnailTimestamp` never returns a value at or beyond the duration and returns a valid position for a video shorter than one second |

The real binaries are not exercised here by design. `ffprobe` and `ffmpeg` live in the worker image only (TD-04), and the API container that runs this suite does not have them. Their real behaviour is proven end to end in SI-03.10, against the actual worker container, which is a stronger check than a mocked binary and needs no ffmpeg where it does not belong. A test that skipped itself when the binary is missing would be worse than either: it would report green while asserting nothing.

**Dependencies:** SI-03.1

**Acceptance criteria:**

- The probe argv is exactly the documented one and the thumbnail argv places `-ss` before `-i`, which is the difference between seeking and decoding an entire remote file
- A command that exits 0 with no output raises an error rather than producing an empty result
- `thumbnailTimestamp(0.5)` returns a position inside the video

---

### SI-03.10 — Video Worker: Image, Bootstrap, and Processor

**Description:** The worker of TD-04: its own image with FFmpeg, its own process booted as a Nest standalone application context, consuming `video-processing` and driving the status lifecycle of TD-09.

**Technical actions:**

- Create `nestjs-project/Dockerfile.worker` — same Node major as `Dockerfile.dev`, plus `apt install ffmpeg`, running as a non-root user
- Add `video-worker` to `nestjs-project/compose.yaml` — built from `Dockerfile.worker`, same bind mount, `command: npm run worker`, depending on `db`, `redis` and `minio` being healthy
- Add `"worker": "ts-node -r tsconfig-paths/register src/worker.ts"` to `package.json` scripts
- Create `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)`, no HTTP server. Handles `SIGTERM` and `SIGINT` by closing the context so in-flight jobs finish and connections close
- Create `src/videos/video-processing.processor.ts` — `@Processor('video-processing')` extending `WorkerHost`:
  1. load the video by id (payload is `{ videoId }` only, TD-10)
  2. presign an **internal** `GET` with a TTL covering the job timeout, and hand that URL to FFmpeg (TD-05)
  3. `probe`, then `extractThumbnail` at the derived timestamp
  4. upload the thumbnail to the thumbnails bucket under the key of TD-03
  5. persist `duration_seconds`, `metadata`, `thumbnail_key`, and set `status = ready`
  6. on error: if `job.attemptsMade + 1 < job.opts.attempts`, **rethrow** so BullMQ retries and the video stays `processing`; on the last attempt, persist `processing_error` and set `status = failed`, then rethrow so the job is recorded as failed
- Create `src/videos/worker.module.ts` — the module graph the worker needs: config, TypeORM, storage, the processor. It does not import controllers

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-processing.processor.spec.ts` | Unit | The happy path writes duration, metadata, thumbnail key and `ready`; a failure on a non-final attempt rethrows and leaves the status `processing`; a failure on the final attempt writes `processing_error` and `failed`; the URL handed to FFmpeg is the internal one |
| `test/videos.e2e-spec.ts` (extended) | E2E | Full pipeline against the real worker container: upload a fixture, complete, poll until `ready` with a bounded timeout, then assert a plausible `duration_seconds`, a non-null `thumbnail_key`, and a thumbnail object in storage that is non-empty and starts with the JPEG magic bytes |

**Dependencies:** SI-03.8, SI-03.9

**Acceptance criteria:**

- `docker compose up -d` starts `video-worker` and it reports `running`
- A completed upload reaches `ready` without any manual step
- `duration_seconds` matches the fixture's known duration within tolerance
- The stored thumbnail is non-empty and is a JPEG. Asserting non-emptiness is not pedantry: a thumbnail cut past the end of the video is produced with exit code 0 and zero bytes, so size is the only signal that separates it from a real frame
- A video whose source object is unreadable ends as `failed` with a non-empty `processing_error`, not stuck in `processing`

---

### SI-03.11 — Public Read: Metadata, Streaming, Download, Thumbnail

**Description:** The public surface of a processed video, plus the authenticated status endpoint the owner uses while it is still being processed.

**Technical actions:**

- `GET /videos/:publicId` — `@Public()`, returns the video only when `ready`; any other status returns `VIDEO_NOT_FOUND`. A draft must not be discoverable by guessing its public id
- `GET /videos/:publicId/stream` — `@Public()`, `302` to a presigned `GET` signed with the public endpoint, TTL `VIDEO_PLAYBACK_URL_TTL_SECONDS`
- `GET /videos/:publicId/download` — `@Public()`, `302` to a presigned `GET` carrying `ResponseContentDisposition: attachment; filename="<original_filename>"`
- `GET /videos/:publicId/thumbnail` — `@Public()`, `302`, or `THUMBNAIL_NOT_AVAILABLE` when `thumbnail_key` is null
- `GET /videos/:id/status` — authenticated and owner-only, by internal id, returning `status`, `processing_error`, `duration_seconds`. This is the polling surface, and it is deliberately separate from the public routes: the global guard does not populate `request.user` on a `@Public()` route, so one route cannot serve both audiences without weakening the guard
- Create `src/videos/dto/video.response.dto.ts` and `video-status.response.dto.ts`, both with explicit `@ApiProperty` on every field
- Regenerate `openapi.json` with `npm run openapi:export` and propagate it with `scripts/sync-openapi.sh`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos.e2e-spec.ts` (extended) | E2E | `GET /videos/:publicId` returns 200 for `ready` and 404 for `draft` or `processing`; the three redirect routes return `302` with a `Location` on the **public** host; following the `Location` with `Range: bytes=0-1023` yields `206`, a matching `Content-Range` and exactly 1024 bytes; the download `Location` carries `response-content-disposition`; `GET /videos/:id/status` returns 401 anonymous, 403 for another user, 200 for the owner |
| `src/videos/videos.service.spec.ts` (extended) | Unit | A non-`ready` video raises `VideoNotFoundException` on the public path, so absence and non-readiness are indistinguishable from outside |

**Dependencies:** SI-03.10

**Acceptance criteria:**

- Streaming works without downloading the whole file: a ranged request returns `206` and exactly the requested bytes
- The download URL causes a browser to save the file under its original name
- A `processing` video is not readable through the public route
- Every new endpoint appears in the regenerated `openapi.json` with its error responses referencing `ApiErrorEnvelope`

---

### SI-03.12 — AI Documentation Update

**Description:** Bring `CLAUDE.md` back in line with the code, at both levels. The enunciado is explicit that documentation citing files or behaviour that do not exist is a failing condition.

**Technical actions:**

- Root `CLAUDE.md`: add the videos section (module, endpoints, queue, worker, storage); replace the **stale** line `next-frontend/ (Next.js) — not yet initialized`, which has been false since the Fase 02 frontend work landed; fill in `Message Queue (TBD)` with the decision from TD-01
- `nestjs-project/CLAUDE.md`: add `minio`, `redis` and `video-worker` to the services list; document `npm run worker`; add the readiness probes for the new services next to the existing `pg_isready` one; record that the worker image carries FFmpeg and the API image does not
- `docs/diagrams/software-arch.mermaid`: replace `Message Queue (TBD)` with the decided technology
- Verify every path cited in both files actually exists, mechanically rather than by reading

**Tests:** no automated tests — verified by a path-existence check over both files.

**Dependencies:** SI-03.11

**Acceptance criteria:**

- Every file path mentioned in either `CLAUDE.md` exists on disk
- No statement in either file contradicts the code: the frontend line, the queue line and the service list are all correct
- The architecture diagram no longer says `TBD`

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| public_id | varchar(16) | unique, not null | 12-char `base64url`, the public URL identifier (TD-07) |
| channel_id | uuid | FK → channels.id, not null | Owner. Resolved from the JWT `sub` at request time (ISS-06) |
| title | varchar(255) | not null | |
| status | enum | not null, default `draft` | `draft`, `processing`, `ready`, `failed` (TD-09) |
| storage_key | varchar(512) | not null | `channels/<channel_id>/videos/<video_id>/source<ext>` (TD-03) |
| thumbnail_key | varchar(512) | nullable | Null until the worker succeeds |
| original_filename | varchar(255) | not null | Used for the download filename |
| content_type | varchar(100) | not null | Client-declared, non-authoritative (TD-12) |
| size_bytes | bigint | nullable | Declared at initiation, **overwritten** with the measured value at completion. Transformer to `number` |
| duration_seconds | numeric(12,3) | nullable | Written by the worker |
| metadata | jsonb | nullable | Width, height, codecs, bitrate as reported by `ffprobe` |
| upload_id | varchar(255) | nullable | S3 multipart `uploadId`; cleared on completion or abort |
| processing_error | text | nullable | Reason, written only when the status becomes `failed` |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one); Channel → Video (one-to-many)
**Indexes:** `(public_id)` unique, `(channel_id)`, `(status)`

---

### API Contracts

#### POST /videos (SI-03.7)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer &lt;access_token&gt;

**Request body:**
- title: string, required — 1 to 255 characters
- filename: string, required — 1 to 255 characters
- content_type: string, required — must be in the configured allowlist
- size_bytes: number, required — positive, at most `VIDEO_MAX_SIZE_BYTES` (10 GiB)

**Response 201:**
- id: string (uuid) — internal id, used for complete/abort/status
- public_id: string — the public URL identifier
- status: string — always `draft`
- upload_id: string — the storage multipart upload id
- part_size_bytes: number — the part size the client must use
- parts: array of `{ part_number: number, url: string }` — one presigned URL per part, ascending from 1

**Error responses:**
- 400 UNSUPPORTED_CONTENT_TYPE: content type outside the allowlist
- 400 FILE_TOO_LARGE: `size_bytes` above the maximum
- 400 validation error: body fails schema validation
- 401: missing or invalid access token
- 404 CHANNEL_NOT_FOUND: the authenticated user has no channel

---

#### POST /videos/:id/complete (SI-03.8)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer &lt;access_token&gt;

**Request body:**
- parts: array, required — `{ part_number: number, etag: string }` for every uploaded part

**Response 200:**
- id: string (uuid)
- public_id: string
- status: string — `processing`
- size_bytes: number — measured by storage, not the declared value

**Error responses:**
- 400 validation error
- 401
- 403 VIDEO_NOT_OWNED: the video belongs to another channel
- 404 VIDEO_NOT_FOUND
- 409 INVALID_VIDEO_STATE: the video is not `draft`, or has no open upload

---

#### POST /videos/:id/abort (SI-03.8)

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;

**Response 204:** No content. The video row remains, as `draft` with no open upload.

**Error responses:**
- 401
- 403 VIDEO_NOT_OWNED
- 404 VIDEO_NOT_FOUND
- 409 INVALID_VIDEO_STATE: no upload to abort

---

#### GET /videos/:id/status (SI-03.11)

**Request headers:**
- Authorization: Bearer &lt;access_token&gt;

**Response 200:**
- id: string (uuid)
- status: string — `draft`, `processing`, `ready` or `failed`
- duration_seconds: number, nullable
- processing_error: string, nullable — non-null only when `failed`

**Error responses:**
- 401
- 403 VIDEO_NOT_OWNED
- 404 VIDEO_NOT_FOUND

---

#### GET /videos/:publicId (SI-03.11)

**Response 200:**
- public_id: string
- title: string
- duration_seconds: number
- channel: `{ id: string, nickname: string, name: string }`
- created_at: string (ISO 8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown identifier **or** a video that is not `ready`. The two are deliberately indistinguishable, so a draft cannot be detected by probing public ids

---

#### GET /videos/:publicId/stream (SI-03.11)

**Response 302:** `Location` is a short-lived presigned `GET` on the public storage endpoint. Byte ranges are served by storage: a request carrying `Range` receives `206 Partial Content` with `Content-Range`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown or not `ready`

---

#### GET /videos/:publicId/download (SI-03.11)

**Response 302:** `Location` is a presigned `GET` carrying `response-content-disposition=attachment; filename="<original_filename>"`.

**Error responses:**
- 404 VIDEO_NOT_FOUND

---

#### GET /videos/:publicId/thumbnail (SI-03.11)

**Response 302:** `Location` is a presigned `GET` for the thumbnail object.

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 404 THUMBNAIL_NOT_AVAILABLE: the video is `ready` but has no thumbnail

---

#### Validation Rules — Video Creation

| Field | Rule | Error |
|-------|------|-------|
| title | 1 to 255 characters | title must be longer than or equal to 1 characters |
| filename | 1 to 255 characters | filename must be shorter than or equal to 255 characters |
| content_type | Must be in `VIDEO_ALLOWED_CONTENT_TYPES` | UNSUPPORTED_CONTENT_TYPE |
| size_bytes | Positive integer | size_bytes must be a positive number |
| size_bytes | At most 10737418240 (10 GiB) | FILE_TOO_LARGE |
| parts[].part_number | Integer between 1 and 10000 | part_number must not be greater than 10000 |
| parts[].etag | Non-empty string | etag should not be empty |

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner only | Notes |
|----------|--------|---------------|------------|-------|
| POST /videos | | ✓ | | Creates in the caller's own channel; no channel id is accepted from the client |
| POST /videos/:id/complete | | ✓ | ✓ | |
| POST /videos/:id/abort | | ✓ | ✓ | |
| GET /videos/:id/status | | ✓ | ✓ | By internal id; the polling surface for the owner |
| GET /videos/:publicId | ✓ | | | `ready` only |
| GET /videos/:publicId/stream | ✓ | | | `ready` only |
| GET /videos/:publicId/download | ✓ | | | `ready` only |
| GET /videos/:publicId/thumbnail | ✓ | | | `ready` only, thumbnail present |

Ownership is decided in the service, never in a guard, per `.claude/rules/nestjs-layer-separation.md`. Ownership means "the video's `channel_id` equals the channel resolved from the token's `sub`".

The four public routes carry `@Public()` and therefore **no** `@ApiBearerAuth`. Announcing a bearer requirement on a route that does not enforce one is a documentation lie the frontend would act on.

---

### Error Catalog

**Error response format:** inherited unchanged from Fase 02.

```
{ statusCode: number, error: string, message: string }
```

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| CHANNEL_NOT_FOUND | 404 | Channel not found for the authenticated user | POST /videos when the user has no channel |
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown id or `public_id`, or a public route reaching a video that is not `ready` |
| VIDEO_NOT_OWNED | 403 | Video belongs to another channel | complete, abort or status on someone else's video |
| INVALID_VIDEO_STATE | 409 | Video is not in a valid state for this operation | complete on a non-`draft` video, complete without an open upload, abort with nothing to abort |
| UNSUPPORTED_CONTENT_TYPE | 400 | Content type is not an accepted video type | POST /videos with a content type outside the allowlist |
| FILE_TOO_LARGE | 400 | File exceeds the maximum allowed size | POST /videos with `size_bytes` above `VIDEO_MAX_SIZE_BYTES` |
| THUMBNAIL_NOT_AVAILABLE | 404 | Thumbnail is not available for this video | GET thumbnail on a `ready` video whose `thumbnail_key` is null |

`VIDEO_NOT_FOUND` covering "not ready" is deliberate and is the reason the owner has a separate authenticated status route.

---

### Events / Messages

Introduced by this phase. There were no asynchronous messages before it.

#### Queue: `video-processing`

| Property | Value | Decided in |
|----------|-------|------------|
| Transport | BullMQ over Redis | TD-01 |
| Producer | `VideosService.completeUpload` (API process) | TD-02 |
| Consumer | `VideoProcessingProcessor` (worker process) | TD-04 |
| Connection host | `redis`, the Compose service name | root `CLAUDE.md` |

#### Message: `process-video`

**Payload:**

```json
{ "videoId": "0f4a1c2e-..." }
```

The payload is minimal by decision (TD-10). The worker reads the current row, so a retry acts on present state instead of an enqueue-time snapshot.

**Options:**

| Option | Value | Rationale |
|--------|-------|-----------|
| `jobId` | the `videoId` | Re-enqueuing the same video is idempotent, so a duplicated completion cannot create two jobs |
| `attempts` | 3 | Total tries, not retries after the first |
| `backoff` | `{ type: 'exponential', delay: 30000 }` | Roughly 30s, 60s, 120s: enough for a transient storage outage |
| `removeOnComplete` | `true` | Successful jobs carry no information the database does not already hold |
| `removeOnFail` | `false` | Retained failed jobs are the dead letter queue. Setting this to `true` would delete the evidence of the failure |

**Effects of consumption:**

| Outcome | Video row |
|---------|-----------|
| Success | `duration_seconds`, `metadata`, `thumbnail_key` written; `status = ready` |
| Failure, attempts remaining | Unchanged, still `processing`; the processor rethrows so BullMQ schedules the retry |
| Failure, last attempt | `processing_error` written; `status = failed`; the processor rethrows so the job is recorded as failed and stays inspectable |

**Delivery semantics:** at-least-once. Processing is idempotent by construction, since every step overwrites the same columns and the same storage key.

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
├── SI-03.3
│   ├── SI-03.4
│   └── SI-03.5
└── SI-03.9

SI-03.6 (no deps)

SI-03.2 + SI-03.3 + SI-03.5 + SI-03.6
└── SI-03.7
    └── SI-03.8
        └── SI-03.10   (also requires SI-03.9)
            └── SI-03.11
                └── SI-03.12
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3, SI-03.6, SI-03.9 (parallel) → SI-03.4, SI-03.5 (parallel) → SI-03.7 → SI-03.8 → SI-03.10 → SI-03.11 → SI-03.12

SI-03.4 is a correction step and does not gate the feature chain, but it must land before the phase closes, because the Definition of Done requires the whole suite green and it is the one test that is red today.

## Deliverables

- [ ] Upload of files up to 10GB with no byte crossing the API, via presigned multipart direct to storage
- [ ] Resumable upload: a failed part is retried alone, without restarting the transfer
- [ ] Video pre-registered as `draft` at the moment the upload starts
- [ ] Automatic processing after completion: duration and metadata extracted with `ffprobe`
- [ ] Thumbnail generated automatically from a frame of the video and stored
- [ ] Unique short public URL identifier per video, guaranteed by a database constraint
- [ ] Streaming without a full download: ranged requests answered with `206 Partial Content`
- [ ] Download of the video under its original filename
- [ ] Status lifecycle `draft` → `processing` → `ready` | `failed` reflected in the database, with the failure reason persisted
- [ ] Object storage (MinIO), queue (Redis) and video worker all starting with `docker compose up`
- [ ] Buckets created idempotently by an infrastructure step, not by the application
- [ ] Migration creating the `videos` table, with the entity related to `channels`
- [ ] Pre-existing failure in `migrations.integration-spec.ts` fixed (ISS-04) and the spec extended for the new migration
- [ ] `.env.example` fixed so `docker compose up` works from a plain copy (ISS-08)
- [ ] `cleanAllTables` aware of the `videos` table, in the correct order
- [ ] `ChannelsService.findByUserId` added, keeping the `Channel` entity owned by its own module
- [ ] `openapi.json` regenerated and propagated to `next-frontend/`
- [ ] Root `CLAUDE.md` and `nestjs-project/CLAUDE.md` updated and consistent with the code, including the stale frontend line and the `TBD` queue
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type check passes (`docker compose exec nestjs-api npx tsc --noEmit`, exit code 0)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds (`docker compose exec nestjs-api npm run build`)
- [ ] Work done on `feature/phase-03-videos` branched from `dev`, with no commit on `main`
