# phase-03-videos — Progress

**Status:** completed
**SIs:** 13/13 completed

**Definition of Done, re-measured on the delivered tree:**

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm test` | exit 0, 265 tests, 32 suites |
| `npm run test:e2e` | exit 0, 70 tests, 4 suites |
| `npm run lint` | exit 0, 0 errors, 163 warnings |
| `npm run build` | exit 0 |

Baseline before the phase, for comparison: 143 of 144 unit and integration tests
passing (one pre-existing failure), 52 e2e passing, `tsc` exit 0, and
`npm run lint` **exit 1 with 150 errors**.

> **The video worker waits for `node_modules` before starting.** Verified by cloning
> this repository fresh and following the enunciado's suggested order: `docker compose
> up -d`, then `npm install`, then migrations, then the suites. The worker runs the
> real application, unlike `nestjs-api`, which idles on `tail -f /dev/null`, and
> `node_modules` lives in the bind mount. Starting before the install meant
> `ts-node: not found`, a dead container that never came back, a queue with no
> consumer, and `videos.e2e-spec.ts` failing 18 tests after 457 seconds of timeouts.
> It passed on the development machine only because `node_modules` was already there
> from earlier runs. With the wait in place the same clean clone runs 70/70 in 10s.

> **`npm test` runs serially by configuration, not by convention.** The
> integration suite shares a single database, so Jest's default parallelism let
> one test truncate a table another was reading: `npm test` exited 1 with 8 red
> suites, and only passed when `--runInBand` was typed by hand. `jest-e2e.json`
> already carried `maxWorkers: 1`; the unit and integration config in
> `package.json` did not. Both are serial now, so the command in the acceptance
> criteria is the command that works, with no flag to remember. Earlier runs of
> this phase were recorded as `npm test -- --runInBand` for that reason.

### SI-03.1 — Dependencies, Configuration Namespaces, and Storage/Queue Infrastructure
- **Status:** completed
- **Tests:** 12/12 passing (env.validation.integration-spec.ts)
- **Observations:** `.env.example` shipped `MAIL_FROM="StreamTube" <noreply@...>`, whose quotes close before the angle brackets. Compose refuses to read the file and `docker compose up` fails outright, which is the first command of the enunciado's suggested order. `nestjs-project/CLAUDE.md` already documented the trap and prescribed the fix. Also found by a test I wrote to prove the opposite: `Joi.string().uri()` accepts `"minio:9000"`, reading it as scheme `minio` with path `9000`. The schema now requires an `http`/`https` scheme, otherwise the value passes validation and fails inside the S3 client, far from its cause.

### SI-03.2 — Storage Module: S3 Client, Presigning, Multipart
- **Status:** completed
- **Tests:** 16 unit + 5 integration against real MinIO
- **Observations:** Two S3 clients, differing only in endpoint. SigV4 signs the `host` header, so a browser-bound URL signed with the Compose service name resolves only inside Docker, and the failure is invisible from a test suite that also runs inside Docker. The integration test therefore asserts on the **host** of the two URLs, not on their behaviour. The expiry test uses a 1-second TTL and a 2.5-second wait: if `expiresIn` were being passed in milliseconds, the URL would still be valid and that test would fail, which is its only reason to exist.

### SI-03.3 — Video Entity, Status Enum, and Migration
- **Status:** completed
- **Tests:** 10 integration (video.entity) + 1 module spec
- **Observations:** `size_bytes` and `duration_seconds` need a numeric transformer. TypeORM returns `bigint` and `numeric` as strings, so without it `size_bytes` comes back as `"10737418240"` and every numeric comparison becomes a string comparison that works for some values and silently does not for others. The test asserts `typeof`, not only the value. Adding the `Channel → Video` relation broke ten existing specs at once with `Entity metadata for Channel#videos was not found`: every test DataSource builds its own entity list.

### SI-03.4 — Migration Spec: Fix the Enum Leak and Cover the New Migration
- **Status:** completed
- **Tests:** 3/3 passing, and passing on four consecutive runs
- **Observations:** The root cause was deeper than the enum. `beforeAll` dropped the tables with `Promise.all`, so six concurrent `DROP TABLE ... CASCADE` on foreign-key-joined tables took locks in different orders and **deadlocked**. The cleanup then aborted halfway, the enum types survived, and the next `runMigrations()` failed with `type already exists` — an error that looks nothing like its cause. The new `videos` foreign key made the collision deterministic, alternating pass and fail on successive runs. Fixed by dropping sequentially and by dropping the enum types too, which `DROP TABLE ... CASCADE` does not remove.

### SI-03.5 — Channel Lookup by Owner
- **Status:** completed
- **Tests:** 2 unit + 2 integration added to the channels suites
- **Observations:** `findByUserId` returns `null` rather than throwing: a user without a channel is a valid state to observe, and only the caller knows whether it is an error in its context. The new constructor parameter broke seven direct instantiations across three specs.

### SI-03.6 — Public Identifier Generator
- **Status:** completed
- **Tests:** 5/5 passing (public-id.util.spec.ts)
- **Observations:** The alphabet is asserted, not only the length: `base64` and `base64url` produce strings that look alike, and the difference (`+`, `/`, `=`) would only surface at routing time.

### SI-03.7 — Upload Initiation with Draft Pre-Registration
- **Status:** completed
- **Tests:** covered by videos.service.spec.ts (32 unit) and videos.e2e-spec.ts
- **Observations:** The 10GB requirement is verified without transferring 10GB: what it actually constrains is the part arithmetic, and that is asserted directly, including the boundaries (exactly one part, one byte over, one byte under, the maximum exactly). Initiating opens a multipart upload that never expires on its own, so a failure to write the row aborts the upload before propagating, mirroring the compensation already used in `UsersService`.

### SI-03.8 — Upload Completion, Abort, and Job Enqueue
- **Status:** completed
- **Tests:** part of the 32 unit tests, plus e2e coverage of the full round trip
- **Observations:** The size declared at initiation is a client claim; completion reads the object with `headObject` and persists the measurement. Two dependency findings, both measured: `@nestjs/bullmq@12` is `"type": "module"` and points the same ESM file at both `import` and `require` — Node 25 tolerates it, Jest's loader does not, and every queue-touching suite died with `Unexpected token 'export'`; version 11.0.5 is CommonJS and covers NestJS 11 with bullmq 6. And `bullmq@6` made `ioredis` optional, so without it the module registers fine and only fails on connect.

### SI-03.9 — FFmpeg Service: Metadata and Thumbnail
- **Status:** completed
- **Tests:** 20/20 passing (ffmpeg.service.spec.ts)
- **Observations:** Both silent-failure modes are now explicit errors. Exit 0 with empty stdout is a failure, not empty metadata. Seeking past the end of a video is **not** an error for FFmpeg: it exits 0 and writes zero bytes, so the thumbnail timestamp is derived from the measured duration and never fixed. `-ss` goes before `-i`, which against a remote multi-gigabyte input is the difference between two range requests and reading the whole file. The real binaries are not exercised here by design: they live only in the worker image, and their real behaviour is covered end to end in SI-03.10. A test that skipped itself when ffmpeg is missing would report green while asserting nothing.

### SI-03.10 — Video Worker: Image, Bootstrap, and Processor
- **Status:** completed
- **Tests:** 10 unit (processor) + the full e2e pipeline against the running container
- **Observations:** The worker had to import `ChannelsModule` and `UsersModule`: TypeORM builds the whole relation graph at startup, so an entity that is only the far side of a relation still has to be registered, and without them the worker died with `Entity metadata for Video#channel was not found`. A failure on a non-final attempt only rethrows and leaves the video `processing`; only exhausting the attempts writes `failed` with the reason. Rethrowing on the last attempt too is what keeps the job in the failed set, which is the dead letter queue.

### SI-03.11 — Public Read: Metadata, Streaming, Download, Thumbnail
- **Status:** completed
- **Tests:** 18 e2e in videos.e2e-spec.ts, plus unit coverage of the not-ready path
- **Observations:** Two harness defects surfaced here. Cleaning tables **before** each test deleted rows while the worker was mid-job, and it came back with a foreign-key violation on a channel that no longer existed — without necessarily failing the test that caused it, which is what makes it dangerous. And `npm run test:e2e` was **not** serial, despite `CLAUDE.md` claiming it was "already configured": with three suites it passed, and the fourth made them collide inside `cleanAllTables` itself. `maxWorkers: 1` now enforces what the documentation already asserted. Separately, the exported `openapi.json` documented **no request body at all**, and had not since the project started: the Swagger plugin is an AST transformer applied by `nest build`, and `openapi:export` ran through `ts-node`, which skips it. The existing guard asserted only `schemas.length > 0`, which passed because response DTOs carry explicit `@ApiProperty` — a detector calibrated where there was no defect.

### SI-03.12 — AI Documentation Update
- **Status:** completed
- **Tests:** no automated tests — every path cited in both `CLAUDE.md` files is checked mechanically
- **Observations:** The root `CLAUDE.md` still said `next-frontend/ — not yet initialized`, which had been false since the Fase 02 frontend work landed, and still listed the queue as `TBD`. Both corrected, along with the architecture diagram.

### SI-03.13 — Lint Debt
- **Status:** completed
- **Tests:** no new tests — `npm run lint` exits 0
- **Observations:** Measured on the untouched `dev` branch first: `npm run lint` exited 1 with 150 errors across 11 files, so the project's own Definition of Done was not satisfiable before this phase. Production-code errors were fixed properly. The remainder lived in a contradiction inside `eslint.config.mjs`, which turns `no-explicit-any` off (the right call for test doubles) while keeping `no-unsafe-assignment` and `no-unsafe-member-access` as errors: an `as any` mock cannot be used without violating them. A test-file override completes that intent, demoting them to warnings so the debt stays visible, while production code keeps full strictness. `unbound-method` is switched off for tests as a documented jest false positive.
