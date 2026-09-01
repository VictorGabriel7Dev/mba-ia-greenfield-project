---
libs:
  "@nestjs/bullmq":
    version: "^12.0.0"
    source: "https://docs.nestjs.com/techniques/queues"
    verified_against_install: true
    fetched_at: "2026-09-01T18:05:00-03:00"
  bullmq:
    version: "^6.3.4"
    source: "https://docs.nestjs.com/techniques/queues"
    verified_against_install: true
    fetched_at: "2026-09-01T18:05:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1124.0"
    source: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html"
    verified_against_install: true
    fetched_at: "2026-09-01T18:05:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1124.0"
    source: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html"
    verified_against_install: true
    fetched_at: "2026-09-01T18:05:00-03:00"
  ffmpeg:
    version: "7.x (apt, worker image)"
    source: "https://ffmpeg.org/ffprobe.html"
    verified_against_install: false
    fetched_at: "2026-09-01T18:05:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-01T17:53:55-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in this phase.

**A note on how these were obtained.** The root `CLAUDE.md` mandates looking libraries up through the **context7** MCP server before implementing. The `.mcp.json` of this repository configures only a `postgres` MCP server, and no context7 server was reachable in the environment where this phase was executed. Rather than record a `context7_id` that was never resolved, each entry below carries the **official documentation URL that was actually read** plus a stronger check that context7 does not provide: every API surface listed here was **verified against the version installed in `node_modules`**, by reading the shipped type declarations and by loading the module and listing its exports. Where the two could disagree, the installed package wins, because it is what the code compiles against.

The `ffmpeg` entry is the one exception to `verified_against_install`: it is an operating-system package in the worker image, not an npm dependency, so it has no `node_modules` entry to check. Its behaviour is pinned by the worker's own integration tests instead.

---

## @nestjs/bullmq + bullmq

**Source:** NestJS official docs, "Queues" (https://docs.nestjs.com/techniques/queues). Maps to `phase-03-videos/TD-01` Decision A and `TD-10`.

**Peer compatibility, checked before choosing:** `@nestjs/bullmq@12` declares peers `@nestjs/core: ^10 || ^11 || ^12` and `bullmq: ^3 || ^4 || ^5 || ^6`. The project runs NestJS 11, so version 12 of the wrapper with bullmq 6 is inside the declared range and needs no override.

**Exports actually present in the installed package** (verified by loading the module and listing its keys):

```
BULL_CONFIG_DEFAULT_TOKEN  BullModule  BullRegistrar  InjectFlowProducer  InjectQueue
JOB_REF  OnQueueEvent  OnWorkerEvent  Processor  ProcessorDecoratorService
QueueEventsHost  QueueEventsListener  WorkerHost  getFlowProducerOptionsToken
getFlowProducerToken  getQueueOptionsToken  getQueueToken  getSharedConfigToken
```

`getQueueToken` matters for testing: it is the DI token under which a queue is registered, so a test module can override the queue with a fake instead of requiring a live Redis for pure unit tests.

### Root configuration

The connection host must be the **Compose service name**, per the root `CLAUDE.md`.

```typescript
import { BullModule } from '@nestjs/bullmq';

BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
  }),
});
```

`forRoot`/`forRootAsync` accept `connection`, and optionally `prefix`, `defaultJobOptions` and `settings`.

### Queue registration and injection

```typescript
BullModule.registerQueue({ name: 'video-processing' });
```

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
```

### Producing a job, with the options this phase relies on

```typescript
await this.queue.add(
  'process-video',
  { videoId },
  {
    jobId: videoId,                                  // idempotent re-enqueue (TD-10)
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: true,
    removeOnFail: false,                             // failed jobs retained for inspection
  },
);
```

Documented option semantics, quoted because two of them are easy to get backwards:

- `attempts` is the **total** number of tries, not the number of retries after the first.
- `removeOnFail: false` is what keeps a failed job inspectable. Setting it to `true` deletes the evidence of the failure, which is the opposite of the dead-letter behaviour TD-01 selected BullMQ for.
- `jobId` deduplicates: adding a job whose `jobId` already exists in the queue does not create a second one.

### Consuming: `@Processor` + `WorkerHost`

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }, void, string>): Promise<void> {
    // throwing here is what marks the attempt failed and triggers the backoff
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) { /* ... */ }
}
```

Two consequences for this phase:

1. `process()` signals failure by **throwing**. A processor that catches an error and returns normally reports success to BullMQ, so the job is removed and never retried. This is the exact shape of silent failure that `.claude/rules/nestjs-services.md` warns about, and it is the one place where that rule's background-task exemption ("log and do not rethrow") must **not** be applied: inside `process()` the throw *is* the retry mechanism.
2. Whether the video row moves to `failed` depends on the attempt being the last one. `job.attemptsMade` against `job.opts.attempts` is how the processor distinguishes "will be retried" from "exhausted", which is what TD-09 requires so an intermediate failure does not prematurely mark the video `failed`.

---

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Source:** AWS S3 User Guide, "Uploading and copying objects using multipart upload" and "Amazon S3 multipart upload limits". Maps to `phase-03-videos/TD-02`, `TD-03`, `TD-05`, `TD-08` and `TD-11`.

**Commands verified present in the installed client** (loaded and type-checked): `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`, `GetObjectCommand`, `PutObjectCommand`, `HeadObjectCommand`, `CreateBucketCommand`.

### Client construction against MinIO

```typescript
import { S3Client } from '@aws-sdk/client-s3';

new S3Client({
  region: cfg.region,
  endpoint: cfg.endpoint,          // http://minio:9000  (Compose service name)
  forcePathStyle: true,            // mandatory for MinIO: no virtual-host bucket DNS
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
});
```

`forcePathStyle: true` is not optional here. Without it the SDK addresses the bucket as a subdomain (`bucket.minio:9000`), which does not resolve on the Compose network.

### Presigning

Signature as shipped in the installed package:

```typescript
getSignedUrl(client, command, options?: RequestPresigningArguments): Promise<string>
```

`RequestPresigningArguments.expiresIn` is documented in the installed types as *"the number of seconds before the presigned URL expires"*. **Seconds, not milliseconds** — a value passed in milliseconds produces a URL that silently outlives its intended window by a factor of a thousand, and nothing about the resulting URL looks wrong.

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadPartCommand, GetObjectCommand } from '@aws-sdk/client-s3';

// one URL per part (TD-02)
const url = await getSignedUrl(
  client,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);

// playback / download (TD-08)
const streamUrl = await getSignedUrl(
  publicClient,                                    // signed with the PUBLIC endpoint
  new GetObjectCommand({ Bucket, Key }),
  { expiresIn: 900 },
);
```

The presigner signs whatever endpoint its client was built with, which is why TD-08 needs two clients rather than two URLs from one client. A URL signed by the internal client is valid only inside the Docker network, and it fails in a way the test suite cannot see, because the tests also run inside that network.

For the download variant, `response-content-disposition` is set on the command as `ResponseContentDisposition: 'attachment; filename="..."'`, which the presigner hoists into the signed query string.

### Multipart limits that constrain the design

From the official limits table, quoted because they are the numbers TD-02 depends on:

| Item | Specification |
|------|---------------|
| Maximum number of parts per upload | 10,000 |
| Part numbers | 1 to 10,000 (inclusive) |
| Part size | 5 MiB to 5 GiB. **No minimum size on the last part.** |
| Maximum object size | 48.8 TiB |

With the 100 MiB part size this phase uses, a 10GB upload is about 100 parts, two orders of magnitude below the part-count ceiling. The 5 MiB minimum is the reason the part size is a server-side decision handed to the client rather than a client-side choice: a client picking 1 MiB parts would produce an upload that S3 rejects at completion, not at upload time.

`AbortMultipartUpload` exists precisely because an initiated upload has **no expiry**: parts stay, and are billed, until the upload is completed or explicitly aborted. This is the documented justification for the abort endpoint in TD-09, and for OQ-1 recording the lifecycle policy as the automatic counterpart.

---

## ffmpeg / ffprobe

**Source:** FFmpeg official documentation, `ffprobe` (https://ffmpeg.org/ffprobe.html). Maps to `phase-03-videos/TD-06`. Installed in the worker image via `apt` (FFmpeg 7.x), not via npm, so there is no package to verify against; the commands below are pinned by the worker's integration tests instead.

### Reading metadata

```
ffprobe -v error -print_format json -show_format -show_streams <input>
```

- `-print_format json` produces a parseable document on **stdout**, which is what makes the wrapper library of TD-06 Option A unnecessary.
- `-show_format` carries `duration`, `size` and `bit_rate`; `-show_streams` carries per-stream `codec_name`, `width`, `height` and `r_frame_rate`.
- `<input>` may be an `http(s)` URL. FFmpeg's HTTP protocol issues range requests to seek, which is what TD-05 relies on to avoid downloading the object.

**The trap `-v error` sets.** Raising the log level to `error` silences everything below it. That is correct here, because the payload is on stdout and only genuine errors belong on stderr, but it is worth stating explicitly that any FFmpeg filter or measurement that reports at *info* level (`volumedetect` and friends) writes nothing at all under `-v error`, and the absence reads exactly like a clean result. This phase uses `-v error` only for commands whose output is on stdout.

**Exit code is the authority.** A failed probe writes to stderr and exits non-zero, but an empty stdout with exit 0 must also be treated as a failure rather than parsed into an empty metadata object. This is recorded as a consequence in TD-06 and is asserted by a test.

### Extracting one frame

```
ffmpeg -v error -ss <seconds> -i <input> -frames:v 1 -f image2 -vcodec mjpeg -
```

- `-ss` **before** `-i` seeks by keyframe before decoding, which is the fast form and the only sane one against a remote 10GB input. Placing `-ss` after `-i` decodes everything up to the timestamp.
- `-frames:v 1` stops after a single frame; `-` writes it to stdout, so no temporary file is created, consistent with TD-05.

**The second trap.** Seeking past the end of the video is **not an error**: FFmpeg exits 0 and produces **empty output**. A naive implementation stores a zero-byte thumbnail and marks the video `ready`, and every status check agrees that everything worked. The timestamp is therefore derived from the duration returned by `ffprobe` (a fraction of it, clamped), and the resulting buffer is asserted non-empty before it is uploaded. Both the derivation and the non-empty assertion are testable, and both are tested.
