import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { ValidationProvider } from './providers/validation.provider.js';
import { ContractProvider } from './providers/contract.provider.js';
import { TransactionProvider } from './providers/transaction.provider.js';
import { StellarService } from '../stellar/stellar.service.js';
import type { SweepExecutionRequest } from './interfaces/execute-sweep.interface.js';
import type { SweepResult } from './interfaces/sweep-result.interface.js';
import { TransactionResult } from './interfaces/transaction-result.interface.js';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';
import { SweepMetricsProvider } from './providers/sweep-metrics.provider.js';
import {
  isSorobanContractFailure,
  throwSweepContractError,
} from '../../common/errors/contract-error.mapper.js';
import {
  advisoryLockKey,
  withAdvisoryLock,
} from '../../common/locks/advisory-lock.util.js';

/** Advisory-lock namespace for the SweepController nonce (#826). */
const SWEEP_CONTROLLER_LOCK_NAMESPACE = 'sweep-controller-nonce';

/**
 * Recognises the SweepController's `InvalidNonce` rejection (#826).
 *
 * The contract defines `Error::InvalidNonce = 11` (bridgelet-core
 * `contracts/sweep_controller/src/errors.rs`), so the host surfaces it as
 * `Error(Contract, #11)` (optionally wrapped in a `HostError`/`simulation
 * failed` message) or, when a client maps it, `InvalidNonce`. This must be
 * checked *before* {@link isSorobanContractFailure}, which also matches any
 * `Error(Contract, ...)`: a stale nonce is a race we retry, not a terminal
 * failure.
 */
function isSweepNonceError(raw: string): boolean {
  return raw.includes('InvalidNonce') || /Error\(Contract,\s*#11\)/.test(raw);
}

@Injectable()
export class SweepsService {
  private readonly logger = new Logger(SweepsService.name);

  constructor(
    private readonly validationProvider: ValidationProvider,
    private readonly contractProvider: ContractProvider,
    private readonly transactionProvider: TransactionProvider,
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
    @InjectMetric('sweep_success_total')
    private readonly sweepSuccessCounter: Counter<string>,
    @InjectMetric('sweep_failure_total')
    private readonly sweepFailureCounter: Counter<string>,
    private readonly sweepMetrics: SweepMetricsProvider,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Execute sweep: authorize the sweep on-chain via the SweepController
   * contract, then pay out via a classic Horizon payment.
   *
   * The controller only authorizes the sweep and transitions the ephemeral
   * account's on-chain state; it holds no balance and performs no token
   * transfer. The SDK is what actually moves the funds, via the classic
   * Horizon payment in Step 4.
   *
   * The authoritative description of the 4-step flow, including a sequence
   * diagram, lives in this module's README rather than here, so it does not
   * have to be reverse-engineered from code comments (#651):
   * {@link ../README.md | src/modules/sweeps/README.md} - see "Sweep Flow".
   *
   * The order of operations below is strict and intentional.
   *
   * ⚠️ If Step 3 succeeds but Step 4 fails, the contract will be in Swept
   * state but no funds will have moved. This is logged as a critical error
   * for manual recovery. Do not retry automatically. The README section
   * "Failure between steps 3 and 4" documents the recovery path.
   */
  public async executeSweep(
    sweepExecutionRequest: SweepExecutionRequest,
  ): Promise<SweepResult> {
    this.logger.log(
      `Executing sweep for account: ${sweepExecutionRequest.accountId}`,
    );

    // Step 1: Validate sweep parameters
    await this.validationProvider.validateSweepParameters(
      sweepExecutionRequest,
    );

    // Steps 2 & 3: Smart-contract authorization.
    // On a retry into PARTIAL_SWEEP the contract is already in Swept state
    // and re-invoking execute_sweep would revert on-chain. The orchestrator
    // (ClaimRedemptionProvider) signals this via skipContractAuth: true and
    // we synthesise the auth hash deterministically from the same inputs
    // for audit-trail purposes.
    let contractAuthHash: string;
    if (sweepExecutionRequest.skipContractAuth) {
      this.logger.log(
        `Skip-contract-auth retry for account ${sweepExecutionRequest.accountId}: ` +
          'contract already in Swept state from prior partial failure.',
      );
      contractAuthHash = this.contractProvider.generateAuthHash(
        sweepExecutionRequest.ephemeralPublicKey,
        sweepExecutionRequest.destinationAddress,
      );
    } else {
      // #812: execute_sweep must run against the instance recorded on the
      // account. The shared `stellar.contracts.ephemeralAccount` config ID is
      // deliberately neither read nor used as a fallback — for accounts
      // created since #811 it is a different account's instance. (Legacy rows
      // that stored that same ID in `contractId` keep working, because the
      // shared contract really does hold their state.)
      if (!sweepExecutionRequest.contractId) {
        throw new Error(
          `Cannot sweep account ${sweepExecutionRequest.accountId}: no ` +
            'EphemeralAccount contract ID is recorded for it.',
        );
      }
      const ephemeralAccountContractId = sweepExecutionRequest.contractId;

      const sweepControllerContractId = this.configService.getOrThrow<string>(
        'stellar.contracts.sweepController',
      );

      // #826: the SweepController nonce is one global counter, so read-nonce →
      // sign → submit has to be serialized across every app instance or two
      // concurrent claims can read the same value and one reverts on-chain.
      // A Postgres transaction-scoped advisory lock keyed on the controller ID
      // does that without a new dependency, and releases on success or failure.
      // The Horizon payout (Step 4) stays outside the lock.
      await withAdvisoryLock(
        this.dataSource,
        advisoryLockKey(
          SWEEP_CONTROLLER_LOCK_NAMESPACE,
          sweepControllerContractId,
        ),
        () =>
          this.authorizeSweepOnChain({
            sweepControllerContractId,
            ephemeralAccountContractId,
            request: sweepExecutionRequest,
          }),
      );

      this.logger.log(
        `Contract sweep authorized for account ${sweepExecutionRequest.accountId}`,
      );

      contractAuthHash = this.contractProvider.generateAuthHash(
        sweepExecutionRequest.ephemeralPublicKey,
        sweepExecutionRequest.destinationAddress,
      );
    }

    // Step 4: Execute the classic Horizon payment to move funds.
    // The SDK — not the contract — moves the funds here. The SweepController
    // only authorized the sweep and marked the account swept; it holds no
    // balance and never calls TokenClient. The payout below is a classic
    // Horizon payment from the ephemeral account's own `G...` address (where
    // the sender funded it).
    // We catch errors here and return a structured partial result
    // (isPartial: true) instead of propagating them: the contract may
    // already be in Swept state by this point and a thrown exception
    // would force the orchestrator into a manual recovery flow.
    // Returning isPartial lets the caller transition the account to
    // PARTIAL_SWEEP and emit a sweep.partial webhook so a retry
    // redemption (or an operator) can pick up the work.
    let transactionResult: TransactionResult;
    try {
      transactionResult =
        await this.transactionProvider.executeSweepTransaction({
          ephemeralSecret: sweepExecutionRequest.ephemeralSecret,
          destinationAddress: sweepExecutionRequest.destinationAddress,
          amount: sweepExecutionRequest.amount,
          asset: sweepExecutionRequest.asset,
        });
      this.sweepSuccessCounter.inc();
    } catch (error) {
      this.sweepFailureCounter.inc();
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `PARTIAL sweep: contract authorized but Horizon payment failed for ` +
          `account ${sweepExecutionRequest.accountId}. Contract auth hash: ` +
          `${contractAuthHash}. Error: ${message}`,
        stack,
      );
      this.sweepMetrics.recordFailed();
      return {
        success: false,
        isPartial: true,
        contractAuthHash,
        amountSwept: sweepExecutionRequest.amount,
        destination: sweepExecutionRequest.destinationAddress,
        error: message,
      };
    }

    this.logger.log(`Sweep complete: txHash=${transactionResult.hash}`);
    this.sweepMetrics.recordCompleted();

    return {
      success: true,
      txHash: transactionResult.hash,
      contractAuthHash,
      amountSwept: sweepExecutionRequest.amount,
      destination: sweepExecutionRequest.destinationAddress,
      timestamp: transactionResult.timestamp,
    };
  }

  /**
   * #826: read the SweepController nonce, sign and submit `execute_sweep`,
   * retrying once with a freshly read nonce if the contract rejects the
   * signature as stale (`InvalidNonce`). The caller holds the controller's
   * advisory lock for the whole call, so the retry races nothing.
   *
   * #812: the nonce is a single global counter incremented after every
   * successful sweep, so it must be read from the contract and signed
   * explicitly; signing a stale value (it used to default to 0n) makes every
   * sweep after the first ever executed by a controller fail on-chain.
   */
  private async authorizeSweepOnChain(params: {
    sweepControllerContractId: string;
    ephemeralAccountContractId: string;
    request: SweepExecutionRequest;
  }): Promise<void> {
    const { sweepControllerContractId, ephemeralAccountContractId, request } =
      params;

    const maxAttempts = 2;
    for (let attempt = 1; ; attempt++) {
      // Step 2: read the live nonce and sign it.
      const nonce = await this.stellarService.getSweepNonce(
        sweepControllerContractId,
      );
      const authSignature = await this.contractProvider.generateAuthSignature({
        ephemeralPublicKey: request.ephemeralPublicKey,
        destinationAddress: request.destinationAddress,
        contractId: ephemeralAccountContractId,
        nonce,
      });

      // Step 3: submit execute_sweep() on the SweepController Soroban contract
      try {
        await this.stellarService.executeSweep({
          sweepControllerContractId,
          ephemeralAccountContractId,
          destination: request.destinationAddress,
          authSignature,
          signerSecret: request.ephemeralSecret,
        });
        return;
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        // Second safety net: a stale-nonce rejection means another instance
        // advanced the counter between our read and submit. Re-read and retry
        // once. Checked before isSorobanContractFailure(), which also matches
        // Error(Contract, ...) and would otherwise map this to a terminal 502.
        if (attempt < maxAttempts && isSweepNonceError(raw)) {
          this.logger.warn(
            `Sweep nonce rejected for account ${request.accountId} ` +
              '(InvalidNonce); retrying once with a freshly read nonce.',
          );
          continue;
        }
        // A Soroban contract failure (for example the host rejecting the
        // invocation with `Error(Auth, InvalidAction)` during simulation) is
        // deterministic: the contract rejects every retry, so surfacing it as
        // a generic 500 only makes the claim page retry uselessly (and trip
        // the throttle). Map it to a distinct, stable 502
        // (SWEEP_CONTRACT_FAILED) with a safe message, and keep the raw host
        // error in the server logs only.
        //
        // The heuristic matches host/contract markers in the raw error. A
        // submit rejection whose serialized errorResult carries one of those
        // markers is also an on-chain contract failure; a pure sequence/fee/
        // ledger-level refusal (e.g. tx_bad_seq) carries none and stays
        // retryable below.
        if (isSorobanContractFailure(raw)) {
          this.logger.error(
            `Soroban contract failure authorizing sweep for account ` +
              `${request.accountId}: ${raw}`,
            error instanceof Error ? error.stack : undefined,
          );
          throwSweepContractError();
        }
        // Transient RPC/network errors are retryable; let them propagate as-is.
        throw error;
      }
    }
  }

  /**
   * Check if account can be swept (validation only, no execution)
   */
  public async canSweep(
    accountId: string,
    destinationAddress: string,
  ): Promise<boolean> {
    return this.validationProvider.canSweep(accountId, destinationAddress);
  }

  /**
   * Get sweep status for an account
   */
  public async getSweepStatus(accountId: string): Promise<{
    canSweep: boolean;
    reason?: string;
  }> {
    return this.validationProvider.getSweepStatus(accountId);
  }
}
