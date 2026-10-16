import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { StellarService } from '../stellar/stellar.service.js';
import { Account } from '../accounts/entities/account.entity.js';
import { AccountStatus } from '../accounts/enums/account-status.enum.js';
import { assertValidAccountStatusTransition } from '../accounts/enums/account-status-transition.util.js';
import { IntervalJobRunner } from '../../common/utils/interval-job-runner.js';

/**
 * PaymentMonitorService - interval-based payment detection.
 *
 * Polls Horizon on a fixed interval for inbound payments to every account still
 * in `PENDING_PAYMENT`. For each payment found it calls
 * `StellarService.recordPayment()` to register it on the contract and moves the
 * account to `PENDING_CLAIM`.
 *
 * Lifecycle:
 *   - onModuleInit()     starts the poll loop (PAYMENT_POLL_INTERVAL_MS, default 30000)
 *   - pollAllAccounts()  one pass over all PENDING_PAYMENT, unexpired accounts
 *   - onModuleDestroy()  clears the interval
 *
 * ## Relationship to PaymentMonitorProvider (#652)
 *
 * `PaymentMonitorProvider` (src/modules/stellar/providers/) does the same job
 * by the opposite mechanism, and the names do not signal that. The split is not
 * "raw Horizon access vs. orchestration" - both talk to Horizon directly, both
 * call `StellarService.recordPayment()`, and both move the account to
 * `PENDING_CLAIM`. The real difference is how a payment is discovered:
 *
 * | | PaymentMonitorService (this file) | PaymentMonitorProvider |
 * |---|---|---|
 * | Mechanism | pull: `setInterval` poll | push: Horizon SSE stream |
 * | Scope | sweeps all `PENDING_PAYMENT` accounts | one stream per watched account |
 * | Started by | `onModuleInit`, automatically | `AccountsService` calling `watch()` |
 * | Cadence | `PAYMENT_POLL_INTERVAL_MS` (default 30s) | as Horizon emits |
 * | Registered in | `PaymentMonitorModule` | `StellarModule` |
 *
 * **Both are live at the same time.** `AppModule` imports both modules, so a
 * single payment is typically seen twice - once by the stream, once by the next
 * poll. That is safe rather than accidental: `recordPayment()` is idempotent on
 * the contract side (`DuplicateAsset` is treated as a no-op in both files) and
 * the status change is a conditional update that only moves
 * `PENDING_PAYMENT -> PENDING_CLAIM`, never backwards.
 *
 * Practical guidance: this poller is the safety net that catches anything the
 * stream misses (dropped connection, restart before `restoreActiveStreams()`).
 * Treat the stream as the low-latency path and this as the backstop, and keep
 * any new detection logic idempotent in the same two ways.
 */
@Injectable()
export class PaymentMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentMonitorService.name);
  private pollRunner: IntervalJobRunner | null = null;
  private horizonServer: StellarSdk.Horizon.Server;

  constructor(
    @InjectRepository(Account)
    private readonly accountsRepository: Repository<Account>,
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
  ) {
    const horizonUrl =
      this.configService.getOrThrow<string>('stellar.horizonUrl');
    this.horizonServer = new StellarSdk.Horizon.Server(horizonUrl);
  }

  onModuleInit(): void {
    const intervalMs = Number(
      this.configService.getOrThrow<number>('app.paymentPollIntervalMs'),
    );
    this.pollRunner = new IntervalJobRunner({
      intervalMs,
      jitterMs: Math.min(Math.floor(intervalMs * 0.1), 5_000),
      task: () => this.pollAllAccounts(),
      onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Payment monitor polling failed: ${message}`);
      },
    });
    this.pollRunner.start();
    this.logger.log(
      `Payment monitor polling started (interval: ${intervalMs}ms)`,
    );
  }

  onModuleDestroy(): void {
    this.pollRunner?.stop();
    this.pollRunner = null;
    this.logger.log('Payment monitor polling stopped');
  }

  /**
   * Polls all non-expired PENDING_PAYMENT accounts for inbound Horizon payments.
   * The `expiresAt: MoreThan(now)` predicate is load-bearing: without it the
   * poller keeps asking Horizon about accounts whose payment window has closed,
   * i.e. exactly the rows `SchedulerService.runExpiryJob()` is about to move to
   * EXPIRED (#721). Per-account failures are isolated — one bad account does
   * not stop the tick (#872: the "failure isolation" suite in
   * payment-monitor.service.spec.ts asserts this for a mixed batch).
   */
  async pollAllAccounts(): Promise<void> {
    const now = new Date();
    const accounts = await this.accountsRepository.find({
      where: {
        status: AccountStatus.PENDING_PAYMENT,
        expiresAt: MoreThan(now),
      },
    });

    if (accounts.length === 0) return;

    this.logger.debug(`Polling ${accounts.length} active account(s)`);

    await Promise.allSettled(
      accounts.map((account) => this.pollAccount(account)),
    );
  }

  private async pollAccount(account: Account): Promise<void> {
    try {
      const payment = await this.findInboundPayment(account);
      if (!payment) return;

      this.logger.log(
        `Payment detected for account ${account.id} (${account.publicKey}): ` +
          `${payment.amount} ${payment.asset_code ?? 'XLM'} from ${payment.from}`,
      );

      await this.processPayment(account, payment);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Poll tick failed for account ${account.id} (${account.publicKey}): ${msg}`,
      );
    }
  }

  async findInboundPayment(
    account: Account,
  ): Promise<StellarSdk.Horizon.ServerApi.PaymentOperationRecord | null> {
    let page = await this.horizonServer
      .payments()
      .forAccount(account.publicKey)
      .order('asc')
      .limit(200)
      .call();

    const cutoff = account.createdAt.toISOString();

    while (page && page.records) {
      for (const record of page.records) {
        if ((record.type as string) !== 'payment') continue;
        const payment =
          record as StellarSdk.Horizon.ServerApi.PaymentOperationRecord;
        if (payment.to !== account.publicKey) continue;
        if (payment.created_at < cutoff) continue;
        return payment;
      }

      // Follow Horizon's paging token / next page link if current page had records
      if (page.records.length > 0 && typeof (page as any).next === 'function') {
        const nextPage = await (page as any).next();
        if (!nextPage || !nextPage.records || nextPage.records.length === 0) {
          break;
        }
        page = nextPage;
      } else {
        break;
      }
    }

    return null;
  }

  async processPayment(
    account: Account,
    record: StellarSdk.Horizon.ServerApi.PaymentOperationRecord,
  ): Promise<void> {
    // #812: record the payment on the EphemeralAccount instance recorded on
    // the account. Accounts created since #811 each get their own instance,
    // so the shared `stellar.contracts.ephemeralAccount` config ID must not be
    // used here — for those rows it is a different account's instance.
    // (Legacy rows that stored that same ID in `contractId` keep working,
    // because the shared contract really does hold their state.)
    if (!account.contractId) {
      throw new Error(
        `Cannot record payment for account ${account.id}: no ` +
          'EphemeralAccount contract ID is recorded for it.',
      );
    }
    const contractId = account.contractId;

    const signerSecret = this.configService.getOrThrow<string>(
      'stellar.fundingSecret',
    );

    const assetAddress = this.resolveAssetAddress(record);
    const amountBigint = this.parseAmountToStroops(record.amount);

    try {
      await this.stellarService.recordPayment({
        contractId,
        amount: amountBigint,
        assetAddress,
        signerSecret,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('DuplicateAsset')) {
        // Payment already recorded on-chain — still sync DB status
        this.logger.warn(
          `DuplicateAsset for account ${account.id} — payment already on contract, syncing DB`,
        );
      } else {
        throw err;
      }
    }

    // #445: the conditional update below is the *mechanism* that makes this
    // safe — it matches on the source status, so it cannot move an account
    // backwards and is a no-op if the account already moved on. The validator
    // is the complementary *guard*: it catches "I typed the wrong constant"
    // at development time. Neither replaces the other — see the design notes in
    // account-status-transition.util.ts.
    //
    // `account.status` is PENDING_PAYMENT: pollAllAccounts() only selects
    // accounts in that status. Asserting the intended edge explicitly (rather
    // than trusting the query) is what makes the two mechanisms checkable
    // against each other.
    assertValidAccountStatusTransition(
      AccountStatus.PENDING_PAYMENT,
      AccountStatus.PENDING_CLAIM,
      `paymentMonitorService.processPayment accountId=${account.id}`,
    );

    // Atomic: only transition from PENDING_PAYMENT → PENDING_CLAIM, never backwards
    await this.accountsRepository.update(
      { id: account.id, status: AccountStatus.PENDING_PAYMENT },
      { status: AccountStatus.PENDING_CLAIM },
    );
    this.logger.log(`Account ${account.id} status → PENDING_CLAIM`);
  }

  protected resolveAssetAddress(
    record: StellarSdk.Horizon.ServerApi.PaymentOperationRecord,
  ): string {
    const networkPassphrase =
      this.configService.getOrThrow<string>('stellar.network') === 'mainnet'
        ? StellarSdk.Networks.PUBLIC
        : StellarSdk.Networks.TESTNET;

    const asset =
      record.asset_type === 'native'
        ? StellarSdk.Asset.native()
        : new StellarSdk.Asset(record.asset_code!, record.asset_issuer);

    return asset.contractId(networkPassphrase);
  }

  private parseAmountToStroops(amount: string): bigint {
    const [whole, fraction = ''] = amount.split('.');
    const paddedFraction = fraction.padEnd(7, '0').slice(0, 7);
    return BigInt(whole) * 10_000_000n + BigInt(paddedFraction);
  }
}
