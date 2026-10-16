import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';
import { AccountStatus } from '../enums/account-status.enum.js';

/**
 * Composite indexes mirror the indexes created in migration
 * 1718100006000-AddHighTrafficIndexes.  They cover the two
 * high-traffic scheduler queries:
 *
 *   • Expiry job   – WHERE status IN (…) AND expiresAt < NOW()
 *   • Init cleanup – WHERE status = 'initializing' AND createdAt < <cutoff>
 *
 * Keeping the decorators here ensures TypeORM's schema-sync check
 * (used in the integration test) stays green after the migration runs.
 */
@Index('IDX_accounts_status_expiresAt', ['status', 'expiresAt'])
@Index('IDX_accounts_status_createdAt', ['status', 'createdAt'])
@Index('IDX_accounts_createdAt', ['createdAt'])
@Index('IDX_accounts_deletedAt', ['deletedAt'])
@Entity('accounts')
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 56, unique: true })
  @Index('IDX_accounts_publicKey')
  publicKey: string;

  @Column({ type: 'varchar', length: 56, nullable: true })
  @Index('IDX_accounts_contractId')
  contractId: string | null;

  // #825: wallet address of the sender who created the account, used to scope
  // GET /accounts and GET /accounts/:id for sender-scoped tokens. Nullable
  // because accounts created by an admin token may be untagged.
  @Column({ type: 'varchar', length: 56, nullable: true })
  @Index('IDX_accounts_senderAddress')
  senderAddress: string | null;

  @Column({ type: 'text' })
  secretKeyEncrypted: string;

  @Column({ type: 'varchar', length: 56 })
  fundingSource: string;

  @Column({ type: 'decimal', precision: 18, scale: 7 })
  amount: string;

  @Column({ type: 'varchar', length: 100 })
  asset: string;

  @Column({
    type: 'enum',
    enum: AccountStatus,
    enumName: 'account_status_enum',
    default: AccountStatus.PENDING_PAYMENT,
  })
  @Index('IDX_accounts_status')
  status: AccountStatus;

  @Column({ type: 'varchar', length: 64, nullable: true })
  @Index('IDX_accounts_claimTokenHash')
  claimTokenHash: string;

  @Column({ type: 'varchar', length: 56, nullable: true })
  destinationAddress: string;

  @Column({ type: 'timestamp' })
  @Index('IDX_accounts_expiresAt')
  expiresAt: Date; // Scheduled expiry time - set on creation, used by the expiry scheduler

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  claimedAt: Date | null;

  // #445: the commented-out `EXPIRED` status write that used to live here is
  // removed. It was a leftover note to a future author from before any expiry
  // flow existed, and it is now actively wrong on two counts:
  //   1. The status write already exists in `SchedulerService.expireAccount()`,
  //      and it is validated against ACCOUNT_STATUS_TRANSITIONS. Duplicating
  //      the note here invited a second, unvalidated copy of the write.
  //   2. `status` and `expiredAt` are two separate columns. An entity
  //      "helper" that set both would have to be an atomic operation, and an
  //      entity is the wrong place for it — `SchedulerService` sets them
  //      together in a single `update()`.
  // See docs/database-schema.md for the PENDING_PAYMENT/PENDING_CLAIM -> EXPIRED
  // transitions and their terminal-state rules.
  @Column({ type: 'timestamp', nullable: true })
  expiredAt: Date | null; // Actual time expiry was processed - set by the expiry handler, null until then

  /**
   * #728, re-confirmed #881: stored as `jsonb`. Metadata is bounded integration context that is
   * write/display-only: it is returned with the account and merged for
   * lifecycle diagnostics, but it is NOT a query surface. Do not filter or
   * search on its contents (`@>`, `->>`, `?`), because no GIN index exists
   * and such queries would sequentially scan `accounts`. If filtering by
   * metadata is ever needed, add a migration creating
   * `CREATE INDEX ... ON accounts USING GIN (metadata jsonb_path_ops)` and a
   * matching `@Index` here first.
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @DeleteDateColumn({ type: 'timestamp', nullable: true })
  deletedAt: Date | null;
}
