---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-01
scope_description: "Backend foundation for large-file video ingestion: queue technology, 10GB upload strategy, object-storage layout, video worker execution and file access, metadata/thumbnail extraction, unique public URL identifier, streaming and download delivery, video status lifecycle, queue message contract, S3 client, and uploaded-file validation."
---

# Technical Decisions - Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` - backend that delivers the video module (upload initiation, multipart completion, metadata read, streaming and download), plus the new infrastructure this phase introduces: object storage, processing queue and video worker.
- `next-frontend/` - Frontend deferred: the video interface (`Página de visualização do vídeo`, player, upload screens) belongs to Fases 04 and 05. No open decision in this document.

**Given, not open:** the object storage technology. `docs/diagrams/software-arch.mermaid` and the root `CLAUDE.md` already fix it as **S3-compatible**, run locally as **MinIO** in Docker. What this document decides is *how* it is used (bucket layout, presigned access, client library), never *which* storage.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` and the architecture diagram both leave the queue as **TBD** - this is the single genuinely open stack decision of the phase. The queue sits between the API (which must return immediately after an upload completes) and the video worker (which runs FFmpeg for seconds to minutes). It must support retries with backoff, because a transient storage or FFmpeg failure should not lose the video, and it must expose failed jobs for inspection so a permanently broken video can be diagnosed instead of vanishing.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue with a first-party NestJS integration. Jobs get `attempts`, `backoff` (fixed or exponential), `removeOnComplete`/`removeOnFail` retention, delayed jobs and per-worker concurrency out of the box. Failed jobs stay in a `failed` set that doubles as a dead letter queue.
- **Pros:** `@nestjs/bullmq@12` declares `@nestjs/core` `^11` as a peer, so it fits the installed NestJS 11 with no version gymnastics. The `@Processor`/`@Process` decorators mirror the DI style already used across the project. Redis is one small container in Compose. Retry, backoff and failure retention are configuration, not code. Largest NestJS community footprint of the four, so failure modes are well documented.
- **Cons:** Adds a stateful service (Redis) to the stack that must be operated and, in production, persisted or accepted as ephemeral. Ordering guarantees are weak and per-queue, not per-entity. Redis memory is the ceiling for queue depth.

### Option B: RabbitMQ via `@nestjs/microservices`
- AMQP broker with a NestJS transport adapter. Exchanges, routing keys, real dead letter exchanges, publisher confirms.
- **Pros:** The most complete messaging semantics of the four: real DLX, routing topologies, per-message acknowledgement, durable queues. Best fit if later phases need fan-out to several consumers.
- **Cons:** Heaviest operational surface here. Retry with exponential backoff is not native and is usually built with delay exchanges or a plugin, which is exactly the mechanism this phase needs most. The `@nestjs/microservices` adapter models RPC and event patterns rather than a job queue, so job state, progress and retry counters would have to be tracked by hand. Phase 03 has one producer and one consumer, which is far below the complexity RabbitMQ pays for.

### Option C: pg-boss (queue on the existing PostgreSQL)
- Job queue implemented as tables and advisory locks inside the PostgreSQL instance the project already runs.
- **Pros:** Zero new infrastructure. A job enqueue can share the same transaction as the video row update, which removes the enqueue-after-commit race entirely (transactional outbox for free). One less container.
- **Cons:** The enunciado requires **queue, storage and worker as real services in `docker compose`**, and a queue that lives inside the existing `db` service adds no service at all, which puts the acceptance criterion at risk. Polling-based dispatch adds latency and constant load to the same database that serves API reads. Couples video-processing throughput to the transactional database.

### Option D: Apache Kafka
- Distributed partitioned log.
- **Pros:** Ordering per partition, replay of the whole history, very high throughput, natural fit if video events later feed analytics.
- **Cons:** Kafka is a log, not a job queue: per-message retry with backoff and per-job failure state have to be built on top. Broker plus coordination is by far the heaviest footprint for a single-consumer workload. Clear overengineering at this stage.

**Recommendation:** **Option A (BullMQ + Redis)** - it is the only option where the two properties this phase actually needs, retry with exponential backoff and durable inspection of failed jobs, are configuration rather than construction. It satisfies the requirement of a real queue service in Compose, which Option C does not, and it costs one small container instead of the operational weight of B or D. Ordering is not a requirement here: each video is processed independently, so the weak ordering guarantee costs nothing.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

---

## TD-02: 10GB Upload Strategy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The capability is explicitly *"sem impacto na performance"*, and `docs/project-plan.md` adds a second requirement in Pontos de Atenção: the upload must *"permitir retomar em caso de falha de conexão"*. Routing 10GB through the NestJS process is the failure mode the enunciado calls out as automatic rejection, so the decision is about which of the non-blocking paths to take, not whether to take one.

**Options:**

### Option A: `multipart/form-data` through the API
- The browser posts the file to a NestJS endpoint, which streams it to storage.
- **Pros:** Simplest client. The API sees every byte, so it can validate content and enforce size before anything is persisted.
- **Cons:** Every byte crosses the API process. A single 10GB upload occupies a connection for the whole transfer, and concurrent uploads multiply memory and socket pressure on the request path that also serves reads. A dropped connection loses the entire transfer with no resumability. This is the path the enunciado names as automatic rejection.

### Option B: Single presigned `PUT` directly to storage
- The API returns one presigned URL; the client `PUT`s the whole file to storage.
- **Pros:** No bytes through the API. Trivial to implement on both sides. One round trip to get the URL.
- **Cons:** **Cannot satisfy the requirement.** The S3 API caps a single `PUT` object at 5GB, which is half the required ceiling. Still not resumable: a failure at 9GB restarts from zero.

### Option C: Presigned **multipart** upload directly to storage
- Three steps. The API calls `CreateMultipartUpload` and returns the `uploadId` plus one presigned `UploadPart` URL per part. The client uploads parts straight to storage, in parallel and in any order, retrying only the parts that fail. The client then posts the collected `ETag`s back and the API calls `CompleteMultipartUpload`.
- **Pros:** No bytes through the API in any step. Covers 10GB with room to spare: with 100MiB parts a 10GB file is 100 parts, far below the 10000-part limit. **Resumability is native** - a failed part is retried alone, which is exactly the Ponto de Atenção in the project plan. Parallel parts also make the upload faster than a single stream. Server-side assembly means storage, not the API, pays the reassembly cost.
- **Cons:** The most client-side work of the three: the client must slice the file, track part numbers and `ETag`s, and call complete. Three endpoints instead of one. Abandoned uploads leave orphan parts in storage that consume space until aborted or expired by lifecycle policy, so an abort path is required rather than optional.

### Option D: tus resumable upload protocol
- Open protocol for resumable uploads, served by a dedicated tus server component.
- **Pros:** Purpose-built for resumability, with mature client libraries and pause/resume across browser sessions.
- **Cons:** Introduces a fourth service to run and to route, alongside storage, queue and worker. The bytes land on the tus server first and then have to be moved into S3, which reintroduces a hop that Option C does not have. The project is already committed to S3-compatible storage, whose native multipart covers the same ground without a new component.

**Recommendation:** **Option C (presigned multipart)** - it is the only option that satisfies both hard requirements at once: 10GB capacity, which rules out B, and resumability, which rules out A and B. It keeps the API on the control plane and the bytes on the data plane, which is what makes the *"sem impacto na performance"* claim structural rather than a matter of tuning. The extra client complexity is real but is paid once, in the frontend phase, against a requirement that has no cheaper solution.

**Decision:** C (presigned multipart upload direct to storage)

---

## TD-03: Object Storage Bucket and Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Videos and thumbnails have opposite access profiles. A thumbnail is small, requested on every listing page, and harmless to expose. A video source file is huge, must respect the visibility rules coming in Fase 04 (`público` vs `unlisted`), and must never be enumerable. The layout chosen now is expensive to change later because it is baked into every stored key.

**Options:**

### Option A: One bucket, type as key prefix (`videos/`, `thumbnails/`)
- **Pros:** One bucket to create and configure. Simplest bootstrap.
- **Cons:** Bucket-level policy, lifecycle rules and, later, CDN origin configuration apply to both classes at once. Making thumbnails publicly readable would either expose the videos too or force object-level ACLs, which are harder to audit than a bucket policy.

### Option B: One bucket per asset class (`streamtube-videos`, `streamtube-thumbnails`)
- **Pros:** Access policy is a property of the bucket, which is the coarse-grained control that is actually easy to reason about and audit. Thumbnails can become public-read or CDN-fronted later without touching video objects. Lifecycle rules differ naturally: aborted multipart parts expire on the video bucket only. Storage class and cost policy can diverge as the platform grows.
- **Cons:** Two buckets to create at bootstrap and two names to configure.

### Option C: One bucket per channel
- **Pros:** Natural tenant isolation; deleting a channel is deleting a bucket.
- **Cons:** Buckets are a scarce, account-level resource with creation limits, and channel count is unbounded by design. Provisioning a bucket in the user-registration path couples account creation to storage availability. Wrong granularity.

**Recommendation:** **Option B** - the split follows the access-control boundary rather than a naming convention, so the policy difference that already exists between the two asset classes is expressed by infrastructure instead of by application code. The cost is one extra bucket name in configuration.

Key layout inside the buckets, common to both:

```
streamtube-videos/       channels/<channel_id>/videos/<video_id>/source<ext>
streamtube-thumbnails/   channels/<channel_id>/videos/<video_id>/thumbnail.jpg
```

The key is derived from immutable identifiers only (`channel_id`, `video_id`), never from the title or the `public_id`. Titles are editable in Fase 04 and `public_id` is a routing concern; binding either into the key would mean rewriting objects when they change.

**Decision:** B (one bucket per asset class, keys derived from immutable ids)

---

## TD-04: Video Worker Execution Model

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram lists **Video Worker (FFmpeg)** as a container distinct from the API. FFmpeg is a large native dependency, and video processing is CPU-bound work whose resource profile has nothing in common with serving HTTP.

**Options:**

### Option A: `@Processor` inside the API process
- **Pros:** No new container, no new image, no duplicated bootstrap. Shares the existing DI graph and TypeORM connection.
- **Cons:** CPU-bound FFmpeg runs would compete with request handling in the same process, so a burst of uploads degrades API latency for everyone. FFmpeg would have to be installed in the API image, inflating it and widening its attack surface for a binary the API never calls. Contradicts the architecture diagram. Scaling the API and scaling processing become the same knob when they should be independent.

### Option B: Separate container, same image, different command
- **Pros:** Independent process and independent scaling, with a single image to build and keep in sync.
- **Cons:** FFmpeg still has to be in the shared image, so the API image carries it even though only the worker uses it. Same downside as A for image size and surface, without its simplicity.

### Option C: Separate container with its own image (`Dockerfile.worker`, Node + FFmpeg)
- **Pros:** FFmpeg lives only where it is used. API and worker scale, restart and fail independently. Matches the architecture diagram exactly. The worker boots as a Nest **standalone application context** (`NestFactory.createApplicationContext`), so it reuses the project's modules, config and TypeORM setup without starting an HTTP server it does not need.
- **Cons:** A second Dockerfile and a second build. The two images must stay on the same Node major version, which is a real drift risk that has to be watched.

**Recommendation:** **Option C** - the FFmpeg dependency is the deciding factor. It is heavy, native, and used by exactly one of the two processes, so it belongs in exactly one image. The standalone application context keeps the cost low: the worker is the same codebase and the same modules, only without the HTTP layer.

**Decision:** C (separate container, dedicated image with FFmpeg, Nest standalone application context)

---

## TD-05: How the Worker Reads the Video File

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** To read duration and metadata and to cut one frame, the worker needs the file. The file can be 10GB. Whether it copies those bytes anywhere is an architectural decision, not an implementation detail: it determines the worker's disk requirement and most of its wall-clock time.

**Options:**

### Option A: Download the whole object to local disk, then run FFmpeg on the file
- **Pros:** Simplest and most predictable. FFmpeg operates on a local file, which is its best-supported input. No dependency on the storage endpoint's range support.
- **Cons:** Requires up to 10GB of scratch disk **per concurrent job**, which turns worker concurrency into a disk-capacity problem. The full transfer happens before any processing starts, so the job duration is dominated by copying bytes that FFmpeg will mostly never read. Temp files must be cleaned up on every exit path, including crashes.

### Option B: Read directly from storage over HTTP with a presigned `GET`, letting FFmpeg range-seek
- FFmpeg and ffprobe accept an HTTP URL as input and issue HTTP range requests to seek. S3 and MinIO both support ranges.
- **Pros:** No scratch disk at all, so concurrency is bounded by CPU rather than by disk. Only the bytes actually needed cross the network: the container header plus the region around the thumbnail frame, which for a 10GB file is a tiny fraction of the object. Job start is immediate.
- **Cons:** Depends on the storage endpoint honouring range requests, which MinIO and S3 do but which becomes a hard dependency. Performance degrades for containers whose index sits at the end of the file, since ffprobe must seek to the tail before it can read anything. The presigned URL must outlive the whole job, so its TTL is a correctness parameter, not just a security one.

### Option C: Volume shared between API and worker
- **Pros:** No transfer at all if the API already has the bytes.
- **Cons:** The API deliberately never has the bytes (TD-02), so there is nothing to share. Also reintroduces node-local state, which is exactly what object storage exists to remove.

**Recommendation:** **Option B** - the asymmetry is decisive. The worker needs kilobytes of metadata and one frame, and Option A pays for gigabytes to get them. Removing the scratch-disk requirement also removes the coupling between worker concurrency and disk size, which is what would otherwise cap throughput first. The tail-seek cost of Option B is bounded by two extra range requests, against a full copy in Option A.

Consequence recorded for the plan: the presigned `GET` handed to FFmpeg is generated with a TTL that covers the job timeout with margin, and it uses the **internal** storage endpoint (the Compose service name), never the public one.

**Decision:** B (presigned `GET` read directly from storage, range seeks)

---

## TD-06: Metadata Extraction and Thumbnail Generation

**Scope:** Backend

**Capability:** Extração de duração e metadados; geração automática de thumbnail a partir de um frame do vídeo

**Context:** Two operations against the same binary toolchain: `ffprobe` to read duration, dimensions, codecs and bitrate, and `ffmpeg` to extract one frame as a JPEG. The decision is how the Node process invokes them.

**Options:**

### Option A: `fluent-ffmpeg`
- **Pros:** Fluent, readable command building. Parses ffprobe output into an object. Widely used in Node tutorials.
- **Cons:** Adds a dependency plus `@types/fluent-ffmpeg` for a project whose usage is two fixed commands. Its callback-based API needs promisifying to satisfy the project rule that every I/O method is `async` with an explicit `Promise<T>`. Its maintenance cadence has been slow, which is a poor trade for a wrapper this thin.

### Option B: Spawn `ffprobe` and `ffmpeg` directly with `node:child_process`
- `ffprobe -v error -print_format json -show_format -show_streams <url>` returns machine-readable JSON on stdout. `ffmpeg -ss <t> -i <url> -frames:v 1 -f image2 -` writes one JPEG to stdout.
- **Pros:** Zero new dependencies. The exact command line is visible in the source, which makes it reproducible by hand when a video misbehaves. `-print_format json` is already a structured contract, so the wrapper Option A provides adds little. Full control over `-v`, timeouts and process kill.
- **Cons:** The project owns argument construction and JSON parsing, including validating that the fields it needs are present. Errors arrive as exit codes and stderr text rather than typed exceptions.

### Option C: `ffmpeg-static` (bundled binary) plus a wrapper
- **Pros:** Removes the need to install FFmpeg in the image.
- **Cons:** Downloads a platform-specific binary at install time, which is fragile in a multi-arch Docker build and makes the image content depend on npm rather than on the base image. TD-04 already gives the worker its own image, so `apt install ffmpeg` is both simpler and auditable.

**Recommendation:** **Option B** - the wrapper in Option A is thin enough that it costs more in dependency and interop than it saves in code. `-print_format json` gives a structured result directly, and having the literal command line in the source is worth a lot the first time a specific file fails to probe.

Two consequences that must be enforced in implementation, both classes of silent failure:

- `ffprobe` writes its findings to **stdout**, but a run that fails writes to stderr and exits non-zero. Exit code is the authority; a zero-length stdout with exit 0 must still be treated as failure rather than parsed into an empty metadata object.
- The thumbnail timestamp cannot be a fixed value larger than the video. Seeking past the end yields **exit 0 and an empty output**, so a naive implementation stores a zero-byte thumbnail and marks the video `ready`. The timestamp is derived from the duration read by `ffprobe`, and the resulting frame must be verified non-empty before upload.

**Decision:** B (direct `child_process` spawn of `ffprobe` and `ffmpeg`)

---

## TD-07: Unique Public URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** `docs/project-plan.md` asks for a URL that is *"curta e única que nunca conflite com outro vídeo"*. It is the permanent public address of the video, so it must be stable across every edit that Fase 04 will allow.

**Options:**

### Option A: The `id` UUID itself
- **Pros:** Already exists, guaranteed unique, zero extra code or columns.
- **Cons:** 36 characters, which fails the *"curta"* requirement. Exposes the primary key in every public URL, coupling the routing surface to the database identity.

### Option B: Short random id from `node:crypto`, stored in a unique column
- `randomBytes(9)` encoded as `base64url` yields a 12-character URL-safe string carrying 72 bits of entropy. Uniqueness is enforced by a unique constraint, with a bounded regeneration retry on collision.
- **Pros:** Short and opaque, exactly the YouTube-style handle the plan describes. Zero new dependencies. The unique constraint, not the generator, is what guarantees correctness, so the guarantee survives any future change of generator. Decoupled from both the primary key and the title.
- **Cons:** One extra column and one extra index. Needs a collision retry path, which must be written and tested even though at 72 bits it will realistically never be taken.

### Option C: `nanoid`
- **Pros:** Purpose-built, well-audited generator with a good default alphabet.
- **Cons:** Solves in a dependency what Option B solves in six lines. The package is published as `type: module` (verified with `npm view nanoid type`), so consuming it from this CommonJS build under `module: nodenext` and from `ts-jest` adds interop friction for no functional gain.

### Option D: Slug derived from the title
- **Pros:** Human-readable and better for SEO.
- **Cons:** Titles are editable in Fase 04, so the public URL would either break on rename or drift from the title it was derived from. Titles also collide constantly and are not guaranteed to produce a usable slug in any language. Directly at odds with *"nunca conflite"*.

**Recommendation:** **Option B** - it meets the two stated requirements, short and never conflicting, with no dependency and no coupling to mutable data. Making the database constraint the source of the guarantee is what keeps it true regardless of how the identifier is generated later.

**Decision:** B (12-character `base64url` id from `node:crypto`, unique column, bounded collision retry)

---

## TD-08: Streaming and Download Delivery

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo); download do vídeo pelo usuário

**Context:** The root `CLAUDE.md` describes the target architecture as *"Frontend (Next.js) -> calls API via REST, **streams from Object Storage**"*. Streaming without a full download means the player must be able to request byte ranges and receive `206 Partial Content`.

**Options:**

### Option A: The API proxies the bytes, implementing `Range` and `206` itself
- **Pros:** Every request passes through application authorization, so visibility rules are enforced per request and access can be logged and revoked instantly. One origin for the client, no CORS considerations.
- **Cons:** Puts the full video traffic back on the API, which is the pressure TD-02 removed from the upload path and would reintroduce on the read path, where volume is far higher. Range handling, `Content-Range`, `Accept-Ranges` and multi-range edge cases become application code that has to be correct. Contradicts the documented architecture.

### Option B: `302` redirect to a short-lived presigned `GET`
- The API authorizes the request, then redirects to a presigned URL. Storage serves the bytes and answers `Range` with `206` natively.
- **Pros:** No video bytes through the API, on either path. Range support comes from the storage layer, already correct and already tested, instead of being reimplemented. Matches the documented architecture. Download differs from streaming by a single query parameter (`response-content-disposition=attachment`), so both capabilities share one mechanism. Puts a CDN in front of storage later without touching the API.
- **Cons:** The presigned URL is a bearer credential for its lifetime and can be shared within the TTL, so the TTL is a security parameter that has to be chosen deliberately and kept short. Authorization is checked at redirect time, not per byte range. The presigned URL must be signed with the **public** endpoint, not the Compose service name, or the browser cannot resolve it.

### Option C: Transcode to HLS and serve a playlist
- **Pros:** Adaptive bitrate, the real answer for heterogeneous networks, and the standard for video platforms at scale.
- **Cons:** Out of scope. Fase 03 asks for duration, metadata and a thumbnail; transcoding renditions is neither in the phase capabilities nor in the deliverables. It would also multiply storage and processing cost per video. Correct future work, wrong phase.

**Recommendation:** **Option B** - it is what the architecture document already specifies, and it is the only option where `206` correctness is inherited from the storage layer rather than written and maintained here. The credential-lifetime cost is real and is answered with a short TTL plus the fact that Fase 03 videos have no visibility restriction yet; when Fase 04 introduces `unlisted`, the authorization check stays where it already is, at redirect time.

Consequence recorded for the plan: the storage client needs **two endpoints**, an internal one used for server-to-server calls (`minio:9000`, the Compose service name required by the root `CLAUDE.md`) and a public one used to sign URLs that reach a browser. Signing a browser-bound URL with the internal endpoint produces a URL that resolves only inside the Docker network, and this fails in a way that is invisible from inside the network, which is exactly where the tests run.

**Decision:** B (`302` to short-lived presigned `GET`, `attachment` disposition for download)

---

## TD-09: Video Status Lifecycle and Processing Failure

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The capability requires the video row to exist as a draft **when the upload starts**, not when it finishes. Between that moment and a playable video there are two long operations that can fail independently: the client-side transfer and the worker-side processing. The status column is what makes that progression observable.

**Options:**

### Option A: Three states (`draft`, `ready`, `failed`)
- **Pros:** Fewest states to reason about and to test.
- **Cons:** Collapses "waiting for the user to finish uploading" and "queued and being processed" into one value, which are the two states an owner most needs to tell apart. Cannot answer "is anything happening right now" from the row.

### Option B: Four states (`draft`, `processing`, `ready`, `failed`)
- `draft` on upload initiation, `processing` when the multipart upload is completed and the job is enqueued, `ready` when the worker succeeds, `failed` when it exhausts its retries.
- **Pros:** Exactly one state per actor: the client owns `draft`, the worker owns `processing` and its two outcomes. Maps one-to-one onto the lifecycle named in the enunciado (`rascunho -> processando -> pronto/erro`). Enough to drive the Fase 04 management panel without adding states later.
- **Cons:** A video whose client abandons the upload stays `draft` forever, so the orphan case needs a cleanup story even if the cleanup itself is deferred.

### Option C: Five or more states, splitting `uploading` from `draft`
- **Pros:** Distinguishes "created but no bytes yet" from "bytes in flight".
- **Cons:** The API cannot observe the difference. TD-02 sends bytes straight to storage, so the transition into `uploading` would have to be self-reported by the client, which makes it a state the backend cannot trust. A state that cannot be verified is worse than absent.

**Recommendation:** **Option B** - it is the smallest set where every transition is caused by an actor the backend can actually observe. Option C fails precisely because the direct-to-storage upload of TD-02 makes the extra state unobservable from the server.

Failure handling, decided together with the states:

- The worker retries on the queue (TD-01) with exponential backoff. Intermediate attempts do **not** move the video out of `processing`, because a transient storage timeout is not a permanent outcome.
- Only exhausting the attempts moves the video to `failed`, and the reason is persisted in a `processing_error` column. A `failed` video that shows no reason is a dead end for whoever has to diagnose it.
- `failed` is not terminal by design: re-enqueuing the same video is a valid recovery, and nothing in the model prevents it.
- An abandoned `draft` keeps its multipart upload open in storage. Aborting it is an explicit endpoint in this phase; expiring the leftovers by lifecycle policy is recorded as future work rather than silently assumed.

**Decision:** B (`draft` -> `processing` -> `ready` | `failed`, error reason persisted, retries do not change status)

---

## TD-10: Queue Message Contract

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload

**Context:** The job travels from the API to the worker through Redis and may sit there, or be retried, minutes after it was created. What it carries determines what the worker sees.

**Options:**

### Option A: Full snapshot of the video in the payload
- **Pros:** The worker needs no database read to start. The payload is a self-contained record of what was true at enqueue time, which is useful when debugging from the queue alone.
- **Cons:** The snapshot ages. On a retry twelve hours later, the worker acts on data that may no longer match the row it is about to update. Duplicates state that PostgreSQL already owns, so the two can disagree with no way to tell which is right. Larger payloads in Redis for no functional gain.

### Option B: Only `{ videoId }`
- **Pros:** The worker reads the current row, so a retry always operates on present state rather than on enqueue-time state. No duplicated state and no possibility of divergence. Minimal payload.
- **Cons:** One database read per job, which is negligible next to the FFmpeg work that follows. Reading the queue alone no longer tells the full story of a job.

**Recommendation:** **Option B** - the worker's first act is to write to that row, so it must read it anyway to know what it is updating. Carrying a snapshot would add a second version of the truth whose only distinctive property is being stale.

Queue contract fixed here:

| Item | Value |
|------|-------|
| Queue name | `video-processing` |
| Job name | `process-video` |
| Payload | `{ videoId: string }` (uuid) |
| `jobId` | the `videoId`, so re-enqueuing the same video is idempotent |
| Attempts | 3 |
| Backoff | exponential, 30s base |
| Retention | completed jobs removed; failed jobs retained for inspection |

**Decision:** B (minimal payload, `jobId` = `videoId`)

---

## TD-11: S3 Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** TD-02 needs `CreateMultipartUpload`, presigned `UploadPart` and `CompleteMultipartUpload`; TD-05 and TD-08 need presigned `GetObject`. The storage runs as MinIO locally and is expected to be S3 in production, so the client must speak both without a code change.

**Options:**

### Option A: `@aws-sdk/client-s3` v3 with `@aws-sdk/s3-request-presigner`
- **Pros:** The reference implementation of the S3 API, and it drives MinIO unchanged by pointing `endpoint` at it with `forcePathStyle: true`. Modular v3 packages keep the install to the S3 client plus the presigner. Presigning multipart part uploads is first-class. Moving from MinIO to real S3 is a configuration change, which is exactly the portability the project assumes.
- **Cons:** Verbose command-object API. The v3 dependency tree is broad even when scoped to one client.

### Option B: `minio` official SDK
- **Pros:** Smaller and more direct API for the same operations.
- **Cons:** Optimises for the local development target rather than the production one. The project states S3-compatible storage with MinIO as the local stand-in, so binding the code to the MinIO client inverts that relationship and makes the eventual move to S3 a code change instead of a configuration change.

**Recommendation:** **Option A** - the deciding question is which of the two targets the code should be written against. The project says MinIO is the local stand-in for S3, so the S3 client is the one that keeps that statement true.

**Decision:** A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, path-style, endpoint from config)

---

## TD-12: Validation of the Uploaded File

**Scope:** Backend

**Capability:** Upload de vídeos; processamento automático do vídeo

**Context:** TD-02 has a direct consequence that must be faced rather than left implicit: the bytes never pass through the API, so **the API cannot inspect what was actually uploaded**. The client declares a content type and a size at initiation, and both are client-supplied claims.

**Options:**

### Option A: Trust the declared content type
- **Pros:** No extra work anywhere.
- **Cons:** Accepts as truth a value the client fully controls. A non-video file is only discovered when the worker fails on it, and it is discovered as an unexplained processing error rather than as a rejected upload.

### Option B: Validate in the worker via `ffprobe`, mark `failed`
- **Pros:** `ffprobe` is the authoritative test: a file it cannot decode is not a playable video, whatever its extension or declared type says. This validation is already running, since the worker must probe the file anyway for duration and metadata. Costs nothing extra and cannot be bypassed by the client. The failure lands in `processing_error` with a real reason.
- **Cons:** The rejection is asynchronous, so the user learns about it after the upload rather than before it. Storage is consumed by a file that will be rejected.

### Option C: Read the object's first bytes from the API after completion and check magic bytes
- **Pros:** Synchronous rejection at completion time, before enqueuing.
- **Cons:** A magic-byte check confirms a container signature, not a decodable video, so it can pass a file that `ffprobe` will still reject. Adds a storage read to the request path to obtain a weaker answer than the check that runs seconds later anyway.

**Recommendation:** **Option B as the authority, with the declared content type kept as a cheap first gate.** The allowlist at initiation costs one validator and rejects the obvious mistakes immediately; it is treated as a hint, never as a guarantee. The decision that matters is that the only check trusted to mark a video playable is the one performed on the actual bytes by the tool that has to decode them.

**Decision:** B (authoritative validation in the worker via `ffprobe`; declared content type allowlisted at initiation as a non-authoritative gate)

---

## Decisions Summary

| Ref | Topic | Decision | New libraries |
|-----|-------|----------|---------------|
| TD-01 | Message queue technology | BullMQ + Redis | `@nestjs/bullmq`, `bullmq` |
| TD-02 | 10GB upload strategy | Presigned multipart, direct to storage | - |
| TD-03 | Bucket and key layout | One bucket per asset class | - |
| TD-04 | Worker execution model | Separate container, own image, standalone context | - |
| TD-05 | Worker file access | Presigned `GET` with range seeks | - |
| TD-06 | Metadata and thumbnail | Direct `child_process` spawn of `ffprobe`/`ffmpeg` | - |
| TD-07 | Unique public URL id | 12-char `base64url` from `node:crypto` | - |
| TD-08 | Streaming and download | `302` to short-lived presigned `GET` | - |
| TD-09 | Status lifecycle | `draft` -> `processing` -> `ready` \| `failed` | - |
| TD-10 | Queue message contract | Minimal payload, `jobId` = `videoId` | - |
| TD-11 | S3 client library | `@aws-sdk/client-s3` + presigner | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| TD-12 | Uploaded-file validation | Authoritative in the worker via `ffprobe` | - |

## Open Questions Deliberately Left Out of Scope

These were identified while deciding the items above and are **not** requirements of Fase 03. They are recorded so they are not mistaken for oversights.

| # | Question | Why it is out of scope |
|---|----------|------------------------|
| OQ-1 | Lifecycle policy expiring abandoned multipart parts | Storage housekeeping, not a phase capability. The abort endpoint covers the explicit case; the automatic one is an infrastructure policy. |
| OQ-2 | Adaptive bitrate (HLS/DASH) renditions | Fase 03 asks for metadata and thumbnail only. See TD-08 Option C. |
| OQ-3 | Per-channel storage quota | No capability in `docs/project-plan.md` mentions quotas. |
| OQ-4 | Antivirus / content moderation scanning | Not in the project plan for any phase. |
| OQ-5 | Serving thumbnails through a CDN | TD-03 makes it possible later; wiring a CDN is a deployment concern of Fase 07. |
| OQ-6 | Re-processing endpoint for `failed` videos | TD-09 leaves `failed` non-terminal, but exposing a retry endpoint is management surface, which belongs to Fase 04. |
