# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `docker compose ps minio` — expect status `healthy`; the buckets are created by the one-shot `minio-init` service, which must show `Exited (0)`

The `video-worker` service is **not** infrastructure: it is application code and
it does start with `docker compose up -d`, because it is a consumer rather than
a server. Confirm it with `docker compose logs video-worker`, which should end
in `Video worker started, consuming video-processing`.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP on `1025`, web UI on `8025`
- `minio` — S3-compatible object storage, API on `9000`, console on `9001`. Also answers to the network alias `storage.streamtube.local`, which is what the public storage endpoint points at in development
- `minio-init` — one-shot `minio/mc` container that creates the buckets idempotently and exits
- `redis` — backing store for the BullMQ processing queue, port `6379`
- `video-worker` — FFmpeg consumer of the `video-processing` queue. Built from `Dockerfile.worker`, which is the **only** image that carries FFmpeg

```bash
# Run the video worker (it already starts with `docker compose up -d`)
docker compose exec video-worker npm run worker
```

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run worker                           # Video worker (run in the video-worker container)
npm run openapi:export                   # Rebuild and export openapi.json

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run serially:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # serial via maxWorkers: 1 in test/jest-e2e.json
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

This was not merely theoretical. `test/jest-e2e.json` carried no worker limit
despite this section claiming the e2e run was "already configured": with three
suites it happened to pass, and the fourth made the suites collide inside
`cleanAllTables` itself, with a foreign-key violation deleting `users` while
another suite was still inserting. `maxWorkers: 1` is now in the config, so the
statement above is enforced rather than assumed.

Tests that involve the worker are **asynchronous across processes**. Asserting a
video's status right after completing its upload asserts on a race: it passes
for the wrong reason on a slow machine and fails intermittently on a fast one.
Poll with a bounded timeout, and clean up **after** the test rather than before
it, so the cleanup never deletes rows the worker is still writing.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## OpenAPI Export

`npm run openapi:export` **builds first, then exports from `dist/`**, and it has
to stay that way.

The `@nestjs/swagger` CLI plugin configured in `nest-cli.json` is a TypeScript
AST transformer applied by `nest build`. It is what turns a request DTO carrying
only `class-validator` decorators into a schema, which is exactly why
`.claude/rules/nestjs-dtos.md` tells you not to add `@ApiProperty` to request
DTOs by hand.

Exporting through `ts-node` skips the transformer. It does not fail: it produces
a document where every request DTO is `{ "type": "object", "properties": {} }`,
which looks like a valid schema and tells the frontend nothing. The project
shipped that way until Fase 03. There is a guard in
`src/openapi-export.integration-spec.ts` that reads the committed `openapi.json`
and fails if any schema is empty.

After changing any DTO or controller, re-export and propagate:

```bash
docker compose exec nestjs-api npm run openapi:export
./scripts/sync-openapi.sh   # from the repo root, on the host
```

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (`AuthModule`, `UsersModule`, `ChannelsModule`, `MailModule`, `VideosModule`) registered in `AppModule`
- `StorageModule` is infrastructure rather than a domain: it is the only place that knows the S3 API exists, and it is imported by whoever needs object storage
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- The video worker is a second entry point (`src/worker.ts`) booting `WorkerModule` as a standalone application context. It shares the codebase and the modules, without the HTTP layer

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
