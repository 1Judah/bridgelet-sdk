import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import { StellarService } from '../stellar.service.js';
import { Account } from '../../../modules/accounts/entities/account.entity.js';
import { AccountStatus } from '../../accounts/enums/account-status.enum.js';
import { assertValidAccountStatusTransition } from '../../accounts/enums/account-status-transition.util.js';

/**
 * PaymentMonitorProvider - Horizon SSE-based payment detection
 *
 * Watches active ephemeral accounts for inbound Stellar payments using
 * Horizon's server-sent event stream. When a payment is detected it:
 *   1. Calls StellarService.recordPayment() to register it on the contract
 *   2. Updates the account status to PENDING_CLAIM in the database
 *
 * Lifecycle:
 *   - watch(account)       called by AccountsService immediately after creation
 *   - unwatch(accountId)   called internally when a terminal state is reached
 *   - onModuleDestroy()    closes all open streams on shutdown
 *
 * Idempotency:
 *   DuplicateAsset errors from the contract are treated as no-ops - the stream
 *   may emit duplicate events and that is handled here, not in StellarService. *
 * ## Relationship to PaymentMonitorService (#652)
 *
 * `PaymentMonitorService` (src/modules/payment-monitor/) does the same job by
 * the opposite mechanism, and the names do not signal that. The split is not
 * "raw Horizon access vs. orchestration" - both talk to Horizon directly, both
 * call `StellarService.recordPayment()`, and both move the account to
 * `PENDING_CLAIM`. The real difference is how a payment is discovered:
 *
 * | | PaymentMonitorProvider (this file) | PaymentMonitorService |
 * |---|---|---|
 * | Mechanism | push: Horizon SSE stream | pull: `setInterval` poll |
 * | Scope | one stream per watched account | sweeps all `PENDING_PAYMENT` accounts |
 * | Started by | `AccountsService` calling `watch()` on creation | `onModuleInit`, automatically |
 * | Cadence | as Horizon emits | `PAYMENT_POLL_INTERVAL_MS` (default 30s) |
 * | Registered in | `StellarModule` | `PaymentMonitorModule` |
 *
 * **Both are live at the same time.** `AppModule` imports `StellarModule` and
 * `PaymentMonitorModule`, so a single payment is typically seen twice - once by
 * the stream, once by the next poll. That is safe rather than accidental:
 * `recordPayment()` is idempotent on the contract side (`DuplicateAsset` is
 * treated as a no-op in both files) and the status change is a conditional
 * update that only moves `PENDING_PAYMENT -> PENDING_CLAIM`, never backwards.
 *
 * Practical guidance: the poller is the safety net that catches anything the
 * stream misses (dropped connection, restart before `restoreActiveStreams()`).
 * Treat the stream as the low-latency path and the poller as the backstop, and
 * keep any new detection logic idempotent in the same two ways.
 *
 * Verified for #713 (duplicate of the already-resolved #652, fixed in PR #778).
 */

@Injectable()
export class PaymentMonitorProvider implements OnModuleDestroy {
  private readonly logger = new Logger(PaymentMonitorProvider.name);

  /** accountId → active EventSource close handle */
  private readonly streams = new Map<string, () => void>();

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

  /**
   * Opens a Horizon payment SSE stream for the given account.
   * Safe to call multiple times for the same account — subsequent calls are
   * ignored if a stream is already active.
   */
  watch(account: Account): void {
    if (this.streams.has(account.id)) {
      this.logger.debug(
        `Already watching account ${account.id} (${account.publicKey})`,
      );
      return;
    }

    this.logger.log(
      `Starting payment stream for account ${account.id} (${account.publicKey})`,
    );

    const closeStream = this.horizonServer
      .payments()
      .forAccount(account.publicKey)
      .cursor('now') // only react to new payments, not historical ones
      .stream({
        onmessage: (record) => {
          if ((record.type as string) !== 'payment') return;
          void this.handlePaymentEvent(
            account,
            record as StellarSdk.Horizon.ServerApi.PaymentOperationRecord,
          ).catch((err: unknown) => {
            // handlePaymentEvent covers recordPayment() errors itself, but
            // asset resolution and the DB status writes can still reject.
            // Without this .catch those become unhandled promise rejections.
            const errMsg = err instanceof Error ? err.message : String(err);
            this.logger.error(
              `Unhandled payment-event error for account ${account.id}: ${errMsg}`,
            );
          });
        },
        onerror: (err) => {
          const errMsg =
            err instanceof Error ? err.message : JSON.stringify(err);
          this.logger.error(
            `Stream error for account ${account.id}: ${errMsg}`,
          );
        },
      });

    this.streams.set(account.id, closeStream);
  }

  /**
   * Stops watching an account and closes its SSE stream.
   * Called automatically when a terminal status is reached.
   */
  unwatch(accountId: string): void {
    const close = this.streams.get(accountId);
    if (!close) return;

    close();
    this.streams.delete(accountId);
    this.logger.log(`Stopped payment stream for account ${accountId}`);
  }

  /** Close all open streams gracefully on app shutdown. */
  onModuleDestroy(): void {
    this.logger.log(
      `Closing ${this.streams.size} active payment stream(s) on shutdown`,
    );
    for (const [id, close] of this.streams) {
      close();
      this.logger.debug(`Closed stream for account ${id}`);
    }
    this.streams.clear();
  }

  /**
   * Restores monitoring for all accounts that are still in PENDING_PAYMENT
   * status at startup. This ensures that accounts created before a restart
   * are not silently orphaned.
   *
   * Should be called once from AccountsModule's onApplicationBootstrap hook.
   */
  async restoreActiveStreams(): Promise<void> {
    const active = await this.accountsRepository.find({
      where: { status: AccountStatus.PENDING_PAYMENT },
    });

    if (active.length === 0) {
      this.logger.log('No active accounts to restore monitoring for');
      return;
    }

    this.logger.log(
      `Restoring payment monitoring for ${active.length} account(s)`,
    );
    for (const account of active) {
      this.watch(account);
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async handlePaymentEvent(
    account: Account,
    record: StellarSdk.Horizon.ServerApi.PaymentOperationRecord,
  ): Promise<void> {
    // Only handle inbound payments to this account's address
    if (record.to !== account.publicKey) return;

    this.logger.log(
      `Inbound payment detected for account ${account.id}: ` +
        `${record.amount} ${record.asset_code ?? 'XLM'} from ${record.from}`,
    );

    // #812: record the payment on the EphemeralAccount instance recorded on
    // the account row. Accounts created since #811 each get their own
    // instance, so the shared `stellar.contracts.ephemeralAccount` config ID
    // must not be used here. This also removes a read of
    // `stellar.ephemeralContractId`, which is not a real config key (it is in
    // neither env-validation nor .env.example) and made every streamed
    // payment throw at this getOrThrow. Mirrors
    // PaymentMonitorService.processPayment().
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

    // Derive asset contract address from the Horizon payment record.
    // XLM (native) is represented as the zero contract address on Soroban.
    const assetAddress = this.resolveAssetAddress(record);

    // Convert the decimal amount string from Horizon to i128 bigint (stroops).
    // Stellar amounts have 7 decimal places: 1 XLM = 10_000_000 stroops.
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

      // DuplicateAsset means the contract already has this payment recorded.
      // This can happen if the stream emits a duplicate event — treat as no-op.
      if (msg.includes('DuplicateAsset')) {
        this.logger.warn(
          `Duplicate payment event ignored for account ${account.id} ` +
            `(asset already recorded on contract)`,
        );
        return;
      }

      // TooManyPayments and InvalidAmount are non-retryable contract errors.
      // Log and stop watching — the account is in a bad state.
      if (msg.includes('TooManyPayments') || msg.includes('InvalidAmount')) {
        this.logger.error(
          `Non-retryable contract error for account ${account.id}: ${msg}. ` +
            `Stopping monitor.`,
        );
        this.unwatch(account.id);
        await this.markAccountFailed(account.id);
        return;
      }

      // Transient/unknown errors — log but leave the stream open so it retries
      // on the next payment event or on the next duplicate event from Horizon.
      this.logger.error(
        `recordPayment() failed for account ${account.id}: ${msg}`,
      );
      return;
    }

    // recordPayment() succeeded — update DB status and stop watching
    await this.markAccountPendingClaim(account.id);
    this.unwatch(account.id);
  }

  private async markAccountPendingClaim(accountId: string): Promise<void> {
    // #445: the write is now *conditional* on the source status, matching
    // `PaymentMonitorService.processPayment()` in the sibling module. This was
    // previously unconditional, which created a real self-transition: the SSE
    // stream stays open after the account reaches PENDING_CLAIM (it is only
    // closed on a `DuplicateAsset`, which only fires for a repeated *asset*,
    // not a different one), so a second inbound payment for a different asset
    // re-entered this method and wrote PENDING_CLAIM over PENDING_CLAIM.
    //
    // That matters because the validator denies X -> X, and the correct fix is
    // to stop emitting the redundant write, not to exempt this call site from
    // validation: a conditional update is a no-op once the account has moved
    // on, which is the idempotency the retry concern actually needs.
    assertValidAccountStatusTransition(
      AccountStatus.PENDING_PAYMENT,
      AccountStatus.PENDING_CLAIM,
      `paymentMonitorProvider.markAccountPendingClaim accountId=${accountId}`,
    );

    const result = await this.accountsRepository.update(
      { id: accountId, status: AccountStatus.PENDING_PAYMENT },
      { status: AccountStatus.PENDING_CLAIM },
    );

    if (result.affected === 0) {
      this.logger.debug(
        `Account ${accountId} was no longer PENDING_PAYMENT; ` +
          `PENDING_CLAIM write skipped (already advanced by the poller or another stream event)`,
      );
      return;
    }

    this.logger.log(`Account ${accountId} status → PENDING_CLAIM`);
  }

  private async markAccountFailed(accountId: string): Promise<void> {
    // #445: reached only from the non-retryable contract errors
    // TooManyPayments / InvalidAmount, on an account this stream has been
    // watching — i.e. PENDING_PAYMENT. Conditional for the same reason as
    // above: an unconditional write could clobber an account that had already
    // advanced to PENDING_CLAIM, moving it *backwards* into FAILED.
    assertValidAccountStatusTransition(
      AccountStatus.PENDING_PAYMENT,
      AccountStatus.FAILED,
      `paymentMonitorProvider.markAccountFailed accountId=${accountId}`,
    );

    const result = await this.accountsRepository.update(
      { id: accountId, status: AccountStatus.PENDING_PAYMENT },
      { status: AccountStatus.FAILED },
    );

    if (result.affected === 0) {
      this.logger.warn(
        `Account ${accountId} was no longer PENDING_PAYMENT; FAILED write skipped`,
      );
      return;
    }

    this.logger.warn(`Account ${accountId} status → FAILED`);
  }

  /**
   * Converts a Horizon payment record's asset to the Soroban contract address
   * expected by recordPayment().
   *
   * For non-native assets the contract address is the Stellar Asset Contract (SAC)
   * address, which Stellar derives deterministically from the classic asset.
   * For native XLM the SAC address is derived from the native asset.
   */
  private resolveAssetAddress(
    record: StellarSdk.Horizon.ServerApi.PaymentOperationRecord,
  ): string {
    let asset: StellarSdk.Asset;

    if (record.asset_type === 'native') {
      asset = StellarSdk.Asset.native();
    } else {
      if (!record.asset_code || !record.asset_issuer) {
        throw new Error(
          `Payment record missing asset_code or asset_issuer for account ${record.to}`,
        );
      }
      asset = new StellarSdk.Asset(record.asset_code, record.asset_issuer);
    }

    // contractId() returns the SAC address for a given network passphrase
    const networkPassphrase =
      this.configService.getOrThrow<string>('stellar.network') === 'mainnet'
        ? StellarSdk.Networks.PUBLIC
        : StellarSdk.Networks.TESTNET;

    return asset.contractId(networkPassphrase);
  }

  /**
   * Converts a Horizon decimal amount string (e.g. "100.5000000") to stroops
   * as a bigint for the i128 contract parameter.
   * 1 unit = 10_000_000 stroops (7 decimal places).
   */
  private parseAmountToStroops(amount: string): bigint {
    // Split on decimal point
    const [whole, fraction = ''] = amount.split('.');
    // Pad or truncate fraction to exactly 7 digits
    const paddedFraction = fraction.padEnd(7, '0').slice(0, 7);
    return BigInt(whole) * 10_000_000n + BigInt(paddedFraction);
  }
}
