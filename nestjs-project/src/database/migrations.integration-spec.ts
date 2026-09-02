import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1788297805040 } from './migrations/1788297805040-CreateVideos';
import { createTestDataSource } from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
  'videos',
];

/**
 * Enum types are independent database objects: a table merely references one.
 * `DROP TABLE ... CASCADE` therefore leaves them behind, and the next
 * `CREATE TYPE` in a migration fails with "type already exists".
 *
 * That is not hypothetical. Before this list existed, the suite passed on a
 * virgin database and failed on any database that had already been migrated by
 * `npm run migration:run`, which is the startup sequence CLAUDE.md prescribes.
 */
const MANAGED_ENUM_TYPES = [
  'verification_tokens_type_enum',
  'videos_status_enum',
];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
          CreateVideos1788297805040,
        ],
      },
    );

    await dataSource.initialize();

    // Sequential, not Promise.all. Concurrent `DROP TABLE ... CASCADE` on
    // tables joined by foreign keys take their locks in different orders and
    // deadlock. When that happens the cleanup aborts halfway, the enum types
    // survive, and the next `runMigrations()` fails with "type already
    // exists" -- a failure that looks nothing like its cause.
    for (const table of [...MANAGED_TABLES, 'migrations']) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    // After the tables: an enum type cannot be dropped while a column uses it.
    for (const type of MANAGED_ENUM_TYPES) {
      await dataSource.query(`DROP TYPE IF EXISTS "${type}"`);
    }
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('should apply all migrations and create every managed table', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(3);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
  });

  it('should revert the last migration and remove the videos table', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['videos']],
    );
    expect(result).toHaveLength(0);
  });

  it('should re-apply the reverted migration, leaving no orphan enum type', async () => {
    // Continues from the previous test, which left CreateVideos reverted.
    //
    // This is the regression that made the suite fail: an enum type is an
    // independent object, so a `down()` that dropped only the table would let
    // `CREATE TYPE` fail on the way back up with "type already exists".
    const orphanTypes = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = ANY($1::text[])`,
      [['videos_status_enum']],
    );
    expect(orphanTypes).toHaveLength(0);

    const reapplied = await dataSource.runMigrations();
    expect(reapplied).toHaveLength(1);
  });
});
