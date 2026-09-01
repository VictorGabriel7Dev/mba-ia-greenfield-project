---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-01T17:56:32-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-01T17:53:55-03:00"
issues: []
advisories:
  - id: ADV-01
    topic: "Jest does not exit after the unit/integration run"
    scope: "nestjs-project"
advisories_count: 1
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._ Six questions were raised while deciding and are recorded as explicitly out of scope in `technical-decisions-phase-03-videos.md` (OQ-1 to OQ-6). They are not gaps: each has a stated reason for belonging to a later phase or to infrastructure policy.

### UI Coverage Gaps

_None._ This phase is backend-only by definition. The video interface belongs to Fases 04 and 05, and `context.md` records it as deferred rather than missing.

## Resolved Issues

Nine issues were raised during validation and resolved before this document reached `clean`. Each is recorded with what it was, and how it was closed.

### ISS-01 — Missing decision: the queue was `TBD` (resolved)

**Kind:** Missing Decision

`docs/project-plan.md` and `docs/diagrams/software-arch.mermaid` both leave **Message Queue (TBD)**, and no prior phase decided it. The phase cannot be planned without it: TD-04, TD-09, TD-10 and every worker-side SI depend on which queue is used.

**Resolution:** decided in TD-01 (BullMQ + Redis). The trap found while comparing options was that a PostgreSQL-backed queue (pg-boss) satisfies "the phase has a queue" while failing "queue, storage and worker are real services in `docker compose`", because it adds no service at all. Recorded in the TD as the reason Option C was rejected.

### ISS-02 — Inherited constraint conflict: Compose service name vs presigned URL (resolved)

**Kind:** Inherited Constraint Conflict

The root `CLAUDE.md` states, without qualification, that a service reaches another service by its **Compose service name**, never `localhost`. TD-08 hands a presigned URL to a **browser**, which is not on the Compose network and cannot resolve `minio`. Applied literally, the inherited rule produces a URL that no client outside Docker can open.

The conflict is dangerous because it is invisible from inside: the integration and e2e suites run inside the `nestjs-api` container, where `minio` resolves fine, so a URL signed with the internal endpoint passes every test and fails only in a real browser.

**Resolution:** the storage configuration carries **two endpoints**. `STORAGE_ENDPOINT` (internal, the Compose service name) is used for every server-to-server call, which is exactly what the inherited rule is about. `STORAGE_PUBLIC_ENDPOINT` is used only to sign URLs that will be handed to a client. The inherited rule is not violated; it is scoped to the traffic it was written for. Recorded as a consequence in TD-08 and specified in the plan.

### ISS-03 — Dependency gap: the migrations test asserts a fixed migration count (resolved)

**Kind:** Dependency Gap

`src/database/migrations.integration-spec.ts` asserts `expect(ranMigrations).toHaveLength(2)` and expects exactly the four Fase 02 tables. The videos migration of this phase makes both assertions false, so an untouched existing test would fail for a legitimate reason.

**Resolution:** updating that spec is part of this phase, allocated to its own SI. The file is inside the phase's blast radius by construction, not by scope creep.

### ISS-04 — Inconsistency: the migrations test fails on an already-migrated database (resolved)

**Kind:** Inconsistency

Found while establishing the "current suite is green" precondition. The suite is **not** green when the project's own prescribed startup sequence is followed.

`beforeAll` drops the four managed tables and the `migrations` table, but never drops the PostgreSQL enum type `verification_tokens_type_enum`. `DROP TABLE ... CASCADE` does not drop an enum type: the type is an independent object that the table merely references. So on a database that was already migrated by `npm run migration:run` (the sequence `nestjs-project/CLAUDE.md` prescribes before running anything), the type survives the cleanup and `runMigrations()` fails on `CREATE TYPE ... verification_tokens_type_enum` with `type already exists`.

Verified rather than assumed, with an experiment designed so it could have disproved the hypothesis:

| Step | Database state | Result |
|------|----------------|--------|
| Run the spec alone on a freshly created schema | no enum type present | **2 passed** |
| Run the same spec again immediately (its own `afterAll` re-applied the migrations, recreating the type) | enum type present | **fails**: `type "verification_tokens_type_enum" already exists` |

The same failure appears in the full suite: **143 of 144 pass**, and the one failure is this spec. The e2e suite is unaffected: **52 of 52 pass**.

**Resolution:** the test's cleanup is incomplete, so the fix belongs to the test, not to the migration. Editing the migration is forbidden by `.claude/rules/typeorm-migrations.md` ("never edit a migration that has already been executed"), and PostgreSQL has no `CREATE TYPE IF NOT EXISTS` to make `up()` idempotent. The `beforeAll` drops the enum type alongside the tables. Allocated to the same SI as ISS-03, since both touch the same file.

### ISS-05 — Dependency gap: `cleanAllTables` does not know about `videos` (resolved)

**Kind:** Dependency Gap

`src/test/create-test-data-source.ts` exports `cleanAllTables`, which deletes from `refresh_tokens`, `verification_tokens`, `channels` and `users`, in that order. A new `videos` table holding a foreign key to `channels` breaks it in a way that is easy to misread: the `DELETE FROM "channels"` starts failing with a foreign-key violation raised in a helper that has nothing to do with the test that fails.

**Resolution:** `videos` is added to the helper, deleted **before** `channels`. Ordering is part of the fix, not incidental.

### ISS-06 — Ambiguity: the JWT payload carries no channel identity (resolved)

**Kind:** Ambiguity

`src/auth/auth.types.ts` defines `JwtPayload` as `{ sub, email }` only. Every video operation is scoped to a **canal**, so ownership cannot be decided from the token alone.

Two readings were open: add `channelId` to the token, or resolve the channel from `sub` on each request. The first is faster but bakes an identity into tokens that live 15 minutes and would go stale against any future change in the user-to-channel relation, and it would mean changing the Fase 02 auth contract from inside Fase 03.

**Resolution:** resolve the channel from `sub` at request time. The Fase 02 token contract is left untouched.

### ISS-07 — Dependency gap: `ChannelsService` has no read method (resolved)

**Kind:** Dependency Gap

Following from ISS-06, the videos module needs "the channel of this user". `ChannelsService` exposes only `createChannel`. Two ways out: inject `Repository<Channel>` directly into the videos service, or add a read method to `ChannelsService`.

The first violates the Single Responsibility principle stated in the root `CLAUDE.md`, which calls out precisely this case ("a service creating an entity from another domain") and asks for extraction into the proper module rather than deferral.

**Resolution:** `ChannelsService` gains `findByUserId`, and the videos module depends on `ChannelsModule`, which already exports `ChannelsService`. The `Channel` entity stays owned by its module.

### ISS-08 — Inconsistency: `.env.example` breaks `docker compose` (resolved)

**Kind:** Inconsistency

Found on the very first command of the suggested execution order, `cd nestjs-project && docker compose up -d`, which refused to start:

```
failed to read .env: line 23: unexpected character "<" in variable name "<noreply@streamtube.com>"
```

`.env.example` ships `MAIL_FROM="StreamTube" <noreply@streamtube.com>`. The quotes close before the angle brackets, so the rest of the line is bare `<` and `>`, which Compose's dotenv parser rejects. Anyone copying `.env.example` to `.env`, which is the documented way to start, cannot bring the stack up.

`nestjs-project/CLAUDE.md` already documents this exact trap under "Environment File Conventions" and prescribes the fix, so the file contradicts its own documentation.

**Resolution:** `MAIL_FROM="StreamTube <noreply@streamtube.com>"`, the form the project's own CLAUDE.md prescribes. The header value is unchanged in meaning.

### ISS-09 — Ambiguity: what "the video is ready" means in a test (resolved)

**Kind:** Ambiguity

The upload-to-`ready` path crosses a process boundary: the API enqueues, the worker processes. A test asserting `status === 'ready'` right after completing the upload asserts on a race. Such a test does not fail honestly, it fails **intermittently**, and worse, it can pass for the wrong reason on a slow machine where the assertion happens to run after an unrelated delay.

**Resolution:** asynchronous outcomes are asserted by polling the row with a bounded timeout and an explicit failure when the timeout expires. The plan states this as a testing requirement rather than leaving it to each test's author. Recorded in `context.md` under Testing Requirements.

## Advisories

### ADV-01 — Jest does not exit after the unit/integration run

Not an issue for this phase and not caused by it, so it does not block `clean`, but it is recorded because this phase adds suites to the same run.

After the unit and integration suites finish, Jest prints:

```
Jest did not exit one second after the test run has completed.
```

and the process stays alive, held by an async operation that was not stopped. The e2e run does not show this and exits with code 0.

The practical consequence is that `npm test` never returns on its own, which matters for the Definition of Done: a suite that reports green but does not terminate cannot be gated on in CI without `--forceExit`, and `--forceExit` would hide a genuine leak.

This phase does not fix it, because diagnosing an open handle in the Fase 02 suites is a separate scope. It is recorded so that a leak introduced by this phase is not mistaken for the pre-existing one, and so the phase does not silently inherit the blame. New suites added here close every `DataSource`, queue connection and storage client they open, in `afterAll`.
