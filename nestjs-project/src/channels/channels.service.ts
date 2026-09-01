import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { appendRandomSuffix, sanitizeNickname } from './nickname.util';
import { Channel } from './entities/channel.entity';

const PG_UNIQUE_VIOLATION = '23505';
const NICKNAME_COLUMN = 'nickname';
const MAX_RETRIES = 5;

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as any;
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(column)
  );
}

@Injectable()
export class ChannelsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
  ) {}

  /**
   * Resolves the channel that belongs to a user.
   *
   * Returns `null` rather than throwing: a user without a channel is a valid
   * state to observe, and only the caller knows whether it is an error in its
   * own context. The videos module owns that decision, not this one.
   *
   * The `Channel` entity stays owned by this module: other modules ask for a
   * channel through this service instead of injecting its repository, which is
   * the Single Responsibility rule the root CLAUDE.md states explicitly.
   */
  async findByUserId(userId: string): Promise<Channel | null> {
    return this.channelRepository.findOne({ where: { user_id: userId } });
  }

  async createChannel(userId: string, email: string): Promise<Channel> {
    const baseNickname = sanitizeNickname(email.split('@')[0]);

    return this.dataSource.transaction(async (manager) => {
      let nickname = baseNickname;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const existing = await manager.findOne(Channel, {
          where: { nickname },
        });
        if (existing) {
          nickname = appendRandomSuffix(baseNickname);
          continue;
        }

        try {
          return await manager.save(
            manager.create(Channel, {
              name: baseNickname,
              nickname,
              user_id: userId,
            }),
          );
        } catch (err) {
          if (isPgUniqueViolationOnColumn(err, NICKNAME_COLUMN)) {
            // Concurrent insert between pre-check and save — retry with new suffix
            nickname = appendRandomSuffix(baseNickname);
          } else {
            throw err;
          }
        }
      }

      throw new Error(
        'Nickname conflict could not be resolved after max retries',
      );
    });
  }
}
