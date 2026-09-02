---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-01T01:18:03-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-01T17:53:55-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-09-01T01:18:03-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-09-01T01:18:03-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-09-01T01:18:03-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** edição das informações do vídeo, visibilidade `público`/`unlisted`, fluxo de rascunho para publicação, painel de gerenciamento e página pública do canal (Fase 04); player, contagem de visualizações e sugestões (Fase 05); likes, comentários e inscrições (Fase 06).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — the video interface is not part of this phase. The enunciado states it explicitly, and `docs/project-plan.md` places the player and the upload screens in Fases 04 and 05.

**Sequencing notes:** Depends on Fase 01 (configuração base) and Fase 02 (autenticação e canais). The dependency on Fase 02 is structural rather than incidental: a video belongs to a **canal**, and the canal only exists because registration creates one per user.

**Neighbors (for boundary detection only):** Fase 02 (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## New Infrastructure Introduced by This Phase

Phase 03 is the first phase to add services to `nestjs-project/compose.yaml` since Fase 02 added Mailpit. Three arrive at once, and all three are named in the architecture diagram as part of the target design:

| Service | Role | Decided in |
|---------|------|------------|
| `minio` | S3-compatible object storage for video files and thumbnails | given by `docs/diagrams/software-arch.mermaid`; layout in TD-03 |
| `redis` | Backing store for the processing queue | TD-01 |
| `video-worker` | FFmpeg consumer of the queue, own image, own process | TD-04 |

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Message Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq@^12.x, bullmq@^6.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | 10GB Upload Strategy | decided | C (presigned multipart, direct to storage) | — |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Object Storage Bucket and Key Layout | decided | B (one bucket per asset class) | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Worker Execution Model | decided | C (separate container, own image, standalone context) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | How the Worker Reads the Video File | decided | B (presigned GET, range seeks) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Metadata Extraction and Thumbnail Generation | decided | B (direct child_process spawn) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Unique Public URL Identifier | decided | B (12-char base64url from node:crypto) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Streaming and Download Delivery | decided | B (302 to short-lived presigned GET) | — |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle and Processing Failure | decided | B (draft/processing/ready/failed) | — |
| phase-03-videos/TD-10 | technical-decisions-phase-03-videos.md | Backend | Queue Message Contract | decided | B (minimal payload, jobId = videoId) | — |
| phase-03-videos/TD-11 | technical-decisions-phase-03-videos.md | Backend | S3 Client Library | decided | A (@aws-sdk/client-s3 + presigner) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-12 | technical-decisions-phase-03-videos.md | Backend | Validation of the Uploaded File | decided | B (authoritative ffprobe check in the worker) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03, phase-03-videos/TD-11 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04, phase-03-videos/TD-10 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-11 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-09 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-12 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06, phase-03-videos/TD-03 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-08 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ + Redis) — the only option where retry with exponential backoff and durable inspection of failed jobs are configuration rather than construction. Satisfies the requirement of a real queue service in Compose, which a PostgreSQL-backed queue does not, at the cost of one small container instead of the operational weight of RabbitMQ or Kafka. Ordering is not a requirement: videos are processed independently.

**Libraries:** `@nestjs/bullmq@^12.x`, `bullmq@^6.x`

### phase-03-videos/TD-02

**Recommendation:** Option C (presigned multipart) — the only option satisfying both hard requirements at once. 10GB capacity rules out the single presigned `PUT` (S3 caps a single object `PUT` at 5GB), and resumability rules out both the `PUT` and the form upload. Keeps the API on the control plane and the bytes on the data plane, which makes "sem impacto na performance" structural instead of a tuning matter.

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** Option B (one bucket per asset class) — the split follows the access-control boundary rather than a naming convention, so the policy difference that already exists between videos and thumbnails is expressed by infrastructure instead of by application code. Keys derive from immutable ids (`channel_id`, `video_id`), never from title or `public_id`, both of which change.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** Option C (separate container with its own image) — FFmpeg is heavy, native, and used by exactly one of the two processes, so it belongs in exactly one image. Booting the worker as a Nest standalone application context keeps the cost low: same codebase and same modules, without the HTTP layer.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Option B (presigned `GET` with range seeks) — the worker needs kilobytes of metadata and one frame; downloading the object first pays for gigabytes to get them. Removing the scratch-disk requirement also removes the coupling between worker concurrency and disk size, which would otherwise cap throughput first.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Option B (direct `child_process` spawn) — `ffprobe -print_format json` is already a structured contract, so a wrapper library costs more in dependency and interop than it saves. Two silent-failure modes must be handled explicitly: a zero-length stdout with exit 0 is a failure, not empty metadata; and a thumbnail timestamp past the end of the video yields exit 0 with empty output.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** Option B (12-character `base64url` from `node:crypto`) — meets both stated requirements, short and never conflicting, with no dependency and no coupling to mutable data. The unique constraint, not the generator, is what guarantees correctness, so the guarantee survives a future change of generator.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Option B (`302` to a short-lived presigned `GET`) — what the root `CLAUDE.md` architecture already specifies ("streams from Object Storage"), and the only option where `206 Partial Content` correctness is inherited from the storage layer instead of reimplemented. Requires the storage client to hold two endpoints, internal for server-to-server calls and public for URLs that reach a browser.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Option B (`draft` -> `processing` -> `ready` | `failed`) — the smallest set where every transition is caused by an actor the backend can observe. A separate `uploading` state fails precisely because the direct-to-storage upload of TD-02 makes it unobservable from the server. Retries do not change the status; only exhausting the attempts moves the video to `failed`, with the reason persisted.

**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** Option B (minimal payload) — the worker must read the row it is about to write anyway, so a snapshot in the payload would add a second version of the truth whose only distinctive property is being stale on a retry. `jobId` is set to `videoId` so re-enqueuing the same video is idempotent.

**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** Option A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) — the project states that MinIO is the local stand-in for S3, and the S3 client is the one that keeps that statement true. Driving MinIO requires only `endpoint` plus `forcePathStyle: true`, so the move to production S3 is a configuration change rather than a code change.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-12

**Recommendation:** Option B (authoritative validation in the worker) — TD-02 has the direct consequence that the API never sees the bytes, so the declared content type is a client-controlled claim. `ffprobe` is the authoritative test and already runs for metadata, so the check costs nothing extra and cannot be bypassed. The declared content type is kept as a cheap, explicitly non-authoritative first gate at initiation.

**Libraries:** —

## Inherited Decisions Detail

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — machine-readable error codes in a `{ statusCode, error, message }` envelope, mapped by a global filter. Phase 03 adds its error codes to the same catalog and throws the same kind of domain exceptions; it introduces no new error contract.

**Libraries:** —

### phase-02-auth/TD-02

**Recommendation:** Custom guards with `@nestjs/jwt` only, registered as a global `APP_GUARD`. Every Phase 03 endpoint is therefore protected by default and must opt out explicitly with `@Public()`.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — Phase 03 DTOs follow the same validation and OpenAPI-inference conventions; the Swagger CLI plugin derives schemas from the validators.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (namespaced config with `registerAs`) — Phase 03 adds `storage`, `queue` and `video` namespaces as new files in `src/config/`, following the existing one-file-per-domain shape.

**Libraries:** —

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — the new environment variables of this phase are added to the same `envValidationSchema`, so a missing storage or queue variable stops the application at bootstrap instead of failing at first use.

**Libraries:** `joi@^17.x`

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories, one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` with `autoLoadEntities: true` and `synchronize: false`; every entity must also be registered in `TypeOrmModule.forFeature([...])` of its owning module or it is silently invisible. _(from phase 01, reinforced by `.claude/rules/nestjs-modules.md`)_
- Services throw domain exceptions extending `DomainException`; controllers never `try/catch`; the global filter maps them to `{ statusCode, error, message }`. _(from phase 02)_
- Every endpoint is protected by the global `JwtAuthGuard`; public routes opt out with `@Public()`. _(from phase 02)_
- Controllers carry full `@nestjs/swagger` annotations, and error responses reference the shared `ApiErrorEnvelope` via `getSchemaPath`. _(from phase 02)_
- Every service inside a Docker container reaches another service by its **Compose service name**, never `localhost`. _(from phase 01, root `CLAUDE.md`)_
- Integration and e2e suites share one database and must run with `--runInBand`. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Origin | Status in this phase |
|------------|--------|----------------------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | phase-02-auth | Already delivered by `phase-02-auth-frontend`; unrelated to this phase. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Interface de upload e player de vídeo | deferred | `next-frontend/` video surfaces belong to Fases 04 and 05. The enunciado states this phase is backend-only. | — |
| Expiração automática de multipart abandonado | deferred | Storage lifecycle policy, not a phase capability. The explicit abort endpoint is delivered; the automatic expiry is recorded as OQ-1. | phase-03-videos/TD-09 |
| Reprocessamento de vídeos em `failed` | deferred | TD-09 keeps `failed` non-terminal, but exposing a retry endpoint is management surface belonging to Fase 04. Recorded as OQ-6. | phase-03-videos/TD-09 |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type. Two properties of this phase change what "tested" means compared to Fase 02:

1. **The infrastructure is real.** MinIO and Redis run in Compose, so storage and queue behaviour is exercised against the actual services rather than mocked. The enunciado is explicit: do not mock what the Compose stack can run for real.
2. **The critical paths are asynchronous.** A test that asserts "the video became `ready`" must wait for the worker rather than assume it. Polling with a bounded timeout is the only honest form, since an assertion made immediately after enqueue would pass for the wrong reason on a slow run and fail intermittently on a fast one.

Specific layer coverage by SI is recorded in `progress.md`.
