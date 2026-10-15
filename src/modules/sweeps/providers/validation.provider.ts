import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Horizon, NotFoundError } from '@stellar/stellar-sdk';
import { Account } from '../../accounts/entities/account.entity.js';
import type { SweepExecutionRequest } from '../interfaces/execute-sweep.interface.js';
import { AccountStatus } from '../../accounts/enums/account-status.enum.js';
import { StellarAddressValidator } from '../../../common/validators/stellar-address.validator.js';

@Injectable()
export class ValidationProvider {
  private readonly logger = new Logger(ValidationProvider.name);

  constructor(
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
  ) {}

  /**
   * Asserts that a destination address exists on the Stellar network (Horizon).
   * Throws BadRequestException (DESTINATION_NOT_FUNDED) if the account does not exist (404).
   * Transient network errors are rethrown so they are not treated as "not funded".
   *
   * @param destinationAddress The Stellar public address to check.
   * @param horizonServerOrUrl Optional Horizon.Server instance or Horizon URL string.
   */
  public async assertDestinationExists(
    destinationAddress: string,
    horizonServerOrUrl?:
      | { loadAccount: (id: string) => Promise<unknown> }
      | string,
  ): Promise<void> {
    return ValidationProvider.assertDestinationExists(
      destinationAddress,
      horizonServerOrUrl,
    );
  }

  public static async assertDestinationExists(
    destinationAddress: string,
    horizonServerOrUrl?:
      | { loadAccount: (id: string) => Promise<unknown> }
      | string,
  ): Promise<void> {
    let server: { loadAccount: (id: string) => Promise<unknown> };
    if (
      horizonServerOrUrl &&
      typeof horizonServerOrUrl === 'object' &&
      'loadAccount' in horizonServerOrUrl &&
      typeof horizonServerOrUrl.loadAccount === 'function'
    ) {
      server = horizonServerOrUrl;
    } else if (
      typeof horizonServerOrUrl === 'string' &&
      horizonServerOrUrl.trim() !== ''
    ) {
      server = new Horizon.Server(horizonServerOrUrl);
    } else {
      const url =
        process.env.STELLAR_HORIZON_URL ||
        'https://horizon-testnet.stellar.org';
      server = new Horizon.Server(url);
    }

    try {
      await server.loadAccount(destinationAddress);
    } catch (error: unknown) {
      if (ValidationProvider.isNotFoundError(error)) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'DESTINATION_NOT_FUNDED',
          code: 'DESTINATION_NOT_FUNDED',
          message:
            'Destination address does not exist on Stellar network and is not funded',
        });
      }

      // Treat network/transient errors as transient; do not report as "not funded"
      throw error;
    }
  }

  /**
   * #827: asserts that a destination already trusts an issued asset before the
   * asset can be swept to it. A Horizon `Payment` of an issued asset fails if
   * the destination has no trustline, so this turns that opaque on-chain
   * failure into a clear 400.
   *
   * The native asset and malformed assets are no-ops; the sweep flow rejects
   * malformed assets earlier via `isValidAssetFormat`.
   *
   * @param destinationAddress The Stellar public address to check.
   * @param asset The asset in `CODE:ISSUER` (or `native`) form.
   * @param horizonServerOrUrl Optional Horizon.Server instance or Horizon URL string.
   */
  public async assertDestinationTrustsAsset(
    destinationAddress: string,
    asset: string,
    horizonServerOrUrl?:
      | { loadAccount: (id: string) => Promise<unknown> }
      | string,
  ): Promise<void> {
    return ValidationProvider.assertDestinationTrustsAsset(
      destinationAddress,
      asset,
      horizonServerOrUrl,
    );
  }

  public static async assertDestinationTrustsAsset(
    destinationAddress: string,
    asset: string,
    horizonServerOrUrl?:
      | { loadAccount: (id: string) => Promise<unknown> }
      | string,
  ): Promise<void> {
    if (!asset || asset === 'native' || asset === 'XLM') {
      return;
    }

    const parts = asset.split(':');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return;
    }
    const [assetCode, assetIssuer] = parts;

    let server: { loadAccount: (id: string) => Promise<unknown> };
    if (
      horizonServerOrUrl &&
      typeof horizonServerOrUrl === 'object' &&
      'loadAccount' in horizonServerOrUrl &&
      typeof horizonServerOrUrl.loadAccount === 'function'
    ) {
      server = horizonServerOrUrl;
    } else if (
      typeof horizonServerOrUrl === 'string' &&
      horizonServerOrUrl.trim() !== ''
    ) {
      server = new Horizon.Server(horizonServerOrUrl);
    } else {
      const url =
        process.env.STELLAR_HORIZON_URL ||
        'https://horizon-testnet.stellar.org';
      server = new Horizon.Server(url);
    }

    let account: unknown;
    try {
      account = await server.loadAccount(destinationAddress);
    } catch (error: unknown) {
      if (ValidationProvider.isNotFoundError(error)) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'DESTINATION_NOT_FUNDED',
          code: 'DESTINATION_NOT_FUNDED',
          message:
            'Destination address does not exist on Stellar network and is not funded',
        });
      }
      throw error;
    }

    const balances =
      (
        account as {
          balances?: Array<{
            asset_code?: string;
            asset_issuer?: string;
          }>;
        }
      ).balances ?? [];

    const trustsAsset = balances.some(
      (balance) =>
        balance.asset_code === assetCode &&
        balance.asset_issuer === assetIssuer,
    );

    if (!trustsAsset) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'DESTINATION_NO_TRUSTLINE',
        code: 'DESTINATION_NO_TRUSTLINE',
        message:
          `Destination address does not trust asset ${assetCode}:${assetIssuer}; ` +
          'it must add a trustline before this asset can be swept',
      });
    }
  }

  private static isNotFoundError(error: unknown): boolean {
    if (error instanceof NotFoundError) {
      return true;
    }
    if (error && typeof error === 'object') {
      const errObj = error as {
        name?: string;
        status?: number;
        response?: { status?: number };
      };
      return (
        errObj.name === 'NotFoundError' ||
        errObj.status === 404 ||
        errObj.response?.status === 404
      );
    }
    return false;
  }

  /**
   * Validate all sweep parameters before execution
   */
  public async validateSweepParameters(
    sweepExecutionRequest: SweepExecutionRequest,
  ): Promise<void> {
    this.logger.log(
      `Validating sweep parameters for account: ${sweepExecutionRequest.accountId}`,
    );

    // Validate destination address
    StellarAddressValidator.assertValid(
      sweepExecutionRequest.destinationAddress,
    );

    // Validate account exists, is in correct state, and has not been
    // soft-deleted (deletedAt: IsNull() is explicit here even though
    // TypeORM's @DeleteDateColumn already filters it, per issue #435).
    const account = await this.accountRepository.findOne({
      where: { id: sweepExecutionRequest.accountId, deletedAt: IsNull() },
    });

    if (!account) {
      throw new NotFoundException(
        `Account ${sweepExecutionRequest.accountId} not found`,
      );
    }

    // Validate ephemeral public key matches
    if (account.publicKey !== sweepExecutionRequest.ephemeralPublicKey) {
      throw new BadRequestException('Ephemeral public key mismatch');
    }

    // Check account status
    // Verify account has received payment
    if (account.status === AccountStatus.PENDING_PAYMENT) {
      throw new BadRequestException('Account has not received payment yet');
    }

    // ClaimRedemptionProvider takes the claim slot (PENDING_CLAIM or
    // PARTIAL_SWEEP -> CLAIMING, under a row lock) BEFORE it calls
    // SweepsService.executeSweep, so a sweep that is legitimately in progress
    // always sees CLAIMING here. Requiring PENDING_CLAIM alone rejected every
    // real redemption with "Account cannot be swept. Status: claiming".
    // PENDING_CLAIM stays allowed for any direct caller that has not taken the
    // slot; every other status (CLAIMED, EXPIRED, FAILED, ...) is still refused.
    if (
      account.status !== AccountStatus.PENDING_CLAIM &&
      account.status !== AccountStatus.CLAIMING
    ) {
      throw new BadRequestException(
        `Account cannot be swept. Status: ${account.status}`,
      );
    }

    // Check account hasn't expired
    if (new Date() > account.expiresAt) {
      throw new BadRequestException('Account has expired');
    }

    // Validate amount is positive
    const amount = parseFloat(sweepExecutionRequest.amount);
    if (isNaN(amount) || amount <= 0) {
      throw new BadRequestException('Amount must be a positive number');
    }

    // Validate amount matches account balance
    if (sweepExecutionRequest.amount !== account.amount) {
      throw new BadRequestException(
        `Amount mismatch: expected ${account.amount}, got ${sweepExecutionRequest.amount}`,
      );
    }

    // Validate asset format
    if (!this.isValidAssetFormat(sweepExecutionRequest.asset)) {
      throw new BadRequestException('Invalid asset format');
    }

    // Validate asset matches
    if (sweepExecutionRequest.asset !== account.asset) {
      throw new BadRequestException(
        `Asset mismatch: expected ${account.asset}, got ${sweepExecutionRequest.asset}`,
      );
    }

    // #827: for an issued asset, the destination must already trust it or the
    // payment will fail on-chain. Checked here (before executeSweep takes the
    // #826 nonce lock) so no network round-trip happens inside the lock.
    await this.assertDestinationTrustsAsset(
      sweepExecutionRequest.destinationAddress,
      sweepExecutionRequest.asset,
      process.env.STELLAR_HORIZON_URL,
    );

    this.logger.log(
      `Validation passed for account: ${sweepExecutionRequest.accountId}`,
    );
  }

  /**
   * Check if account can be swept
   */
  public async canSweep(
    accountId: string,
    destinationAddress: string,
  ): Promise<boolean> {
    try {
      const account = await this.accountRepository.findOne({
        where: { id: accountId, deletedAt: IsNull() },
      });

      if (!account) return false;
      if (account.status !== AccountStatus.PENDING_CLAIM) return false;
      if (new Date() > account.expiresAt) return false;

      StellarAddressValidator.assertValid(destinationAddress);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get detailed sweep status
   */
  public async getSweepStatus(
    accountId: string,
  ): Promise<{ canSweep: boolean; reason?: string }> {
    const account = await this.accountRepository.findOne({
      where: { id: accountId, deletedAt: IsNull() },
    });

    if (!account) {
      return { canSweep: false, reason: 'Account not found' };
    }

    if (!account.publicKey) {
      return {
        canSweep: false,
        reason: 'No public key associated with account',
      };
    }

    if (account.status === AccountStatus.CLAIMED) {
      return { canSweep: false, reason: 'Already swept' };
    }

    if (account.status === AccountStatus.EXPIRED) {
      return { canSweep: false, reason: 'Account expired' };
    }

    if (account.status === AccountStatus.PENDING_PAYMENT) {
      return { canSweep: false, reason: 'Payment not received' };
    }

    if (new Date() > account.expiresAt) {
      return { canSweep: false, reason: 'Account expired' };
    }

    return { canSweep: true };
  }

  /**
   * Validate asset format (native, XLM, or CODE:ISSUER)
   */
  private isValidAssetFormat(asset: string): boolean {
    if (asset === 'native' || asset === 'XLM') {
      return true;
    }

    // Format: CODE:ISSUER
    const parts = asset.split(':');
    if (parts.length !== 2) {
      return false;
    }

    const [code, issuer] = parts;
    // Asset code: 1-12 alphanumeric characters
    if (!/^[a-zA-Z0-9]{1,12}$/.test(code)) {
      return false;
    }

    // Issuer must be valid Stellar address
    return StellarAddressValidator.isValid(issuer);
  }
}
