import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Horizon,
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  Networks,
} from '@stellar/stellar-sdk';
import type { ExecuteTransactionParams } from '../interfaces/execute-transaction-params.interface.js';
import type { TransactionResult } from '../interfaces/transaction-result.interface.js';
import type { MergeAccountParams } from '../interfaces/merge-account-params.interface.js';

/**
 * Fee-bump metadata Horizon returns on a submission.
 *
 * The SDK declares these fields on the wider `TransactionResponse` but not on
 * `SubmitTransactionResponse`, which is what `submitTransaction()` is typed to
 * return - even though Horizon includes them in the submission response for a
 * fee-bumped transaction. Narrowed here so the values can be read without
 * casting to `any`. This is the same SDK-versus-wire gap already documented
 * for `ledger` in transaction-result.interface.ts (#649).
 */
interface FeeBumpSubmitFields {
  fee_bump_transaction?: { hash: string };
  inner_transaction?: { hash: string };
}

interface HorizonErrorResponse {
  response?: {
    data?: {
      extras?: unknown;
    };
  };
  message: string;
  stack?: string;
}

@Injectable()
export class TransactionProvider {
  private readonly logger = new Logger(TransactionProvider.name);
  private readonly server: Horizon.Server;
  private readonly networkPassphrase: string;

  constructor(private readonly configService: ConfigService) {
    const horizonUrl =
      this.configService.getOrThrow<string>('stellar.horizonUrl');
    this.server = new Horizon.Server(horizonUrl);

    const network = this.configService.getOrThrow<string>('stellar.network');
    this.networkPassphrase =
      network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

    this.logger.log('Initialized TransactionProvider');
  }

  /**
   * Execute sweep transaction: transfer all funds to destination
   */
  public async executeSweepTransaction(
    params: ExecuteTransactionParams,
  ): Promise<TransactionResult> {
    this.logger.log(
      `Executing sweep transaction to ${params.destinationAddress}`,
    );

    try {
      // Create keypair from ephemeral secret
      const sourceKeypair = Keypair.fromSecret(params.ephemeralSecret);

      // Load source account
      const sourceAccount = await this.server.loadAccount(
        sourceKeypair.publicKey(),
      );

      // Parse asset (format: "CODE:ISSUER" or "native")
      const asset = this.parseAsset(params.asset);

      // Build payment transaction
      const transaction = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          Operation.payment({
            destination: params.destinationAddress,
            asset: asset,
            amount: params.amount,
          }),
        )
        .setTimeout(30)
        .build();

      // Sign with ephemeral account
      transaction.sign(sourceKeypair);

      // Submit transaction
      const result = await this.server.submitTransaction(transaction);

      this.logger.log(`Sweep transaction successful: ${result.hash}`);

      const ledger = this.toLedgerNumber(result.ledger);

      return {
        hash: result.hash,
        ledger: ledger,
        successful: result.successful,
        timestamp: new Date(),
        ...this.describeFeeBump(result),
      };
    } catch (error) {
      const typedError = error as HorizonErrorResponse;
      this.logger.error(
        `Sweep transaction failed: ${typedError.message}`,
        typedError.stack,
      );

      // Extract more details from Horizon error
      if (typedError.response?.data) {
        const extras = typedError.response.data.extras;
        this.logger.error(`Transaction extras: ${JSON.stringify(extras)}`);
      }

      throw new InternalServerErrorException(
        `Sweep transaction failed: ${typedError.message}`,
      );
    }
  }

  /**
   * Merge ephemeral account into destination to reclaim base reserve
   */
  public async mergeAccount(
    params: MergeAccountParams,
  ): Promise<TransactionResult> {
    this.logger.log(
      `Merging account to reclaim reserve: ${params.destinationAddress}`,
    );

    try {
      // Create keypair from ephemeral secret
      const sourceKeypair = Keypair.fromSecret(params.ephemeralSecret);

      // Load source account
      const sourceAccount = await this.server.loadAccount(
        sourceKeypair.publicKey(),
      );

      // Build account merge transaction
      const transactionBuilder = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      }).setTimeout(30);

      // #827: an issued-asset account holds a trustline, and an AccountMerge
      // fails while the source still has subentries (trustlines). Remove the
      // trustline in the same transaction before merging so the reserve can
      // actually be reclaimed.
      if (params.asset && params.asset !== 'native' && params.asset !== 'XLM') {
        transactionBuilder.addOperation(
          Operation.changeTrust({
            asset: this.parseAsset(params.asset),
            limit: '0',
          }),
        );
      }

      transactionBuilder.addOperation(
        Operation.accountMerge({
          destination: params.destinationAddress,
        }),
      );

      const transaction = transactionBuilder.build();

      // Sign with ephemeral account
      transaction.sign(sourceKeypair);

      // Submit transaction
      const result = await this.server.submitTransaction(transaction);

      this.logger.log(`Account merge successful: ${result.hash}`);

      return {
        hash: result.hash,
        ledger: this.toLedgerNumber(result.ledger),
        successful: result.successful,
        timestamp: new Date(),
        ...this.describeFeeBump(result),
      };
    } catch (error) {
      // Account merge can fail if account still has offers or trustlines
      // This is non-critical as the main sweep was successful
      const typedError = error as HorizonErrorResponse;
      this.logger.warn(
        `Account merge failed (non-critical): ${typedError.message}`,
      );

      throw error; // Re-throw so caller can handle
    }
  }

  /**
   * Coerce Horizon's `ledger` to a number (#647).
   *
   * transaction-result.interface.ts documents that the wire value can be a
   * string even though the SDK types it as `number`. Both submission paths go
   * through this helper so they cannot drift apart again - mergeAccount
   * previously returned `result.ledger` unconverted, so a string ledger would
   * reach consumers typed as a number.
   */
  private toLedgerNumber(rawLedger: number | string): number {
    const ledger = Number(rawLedger);

    if (Number.isNaN(ledger)) {
      throw new Error(`Invalid ledger value: ${rawLedger}`);
    }

    return ledger;
  }

  /**
   * Derive the fee-bump audit fields from a Horizon submission response (#649).
   *
   * Returns `feeBump: false` when Horizon reports no fee-bump envelope, so the
   * field is always populated rather than merely absent.
   */
  private describeFeeBump(
    result: Horizon.HorizonApi.SubmitTransactionResponse,
  ): {
    feeBump: boolean;
    innerTransactionHash?: string;
  } {
    const feeBumpFields = result as FeeBumpSubmitFields;
    const innerTransactionHash = feeBumpFields.inner_transaction?.hash;

    return {
      feeBump: Boolean(feeBumpFields.fee_bump_transaction),
      ...(innerTransactionHash !== undefined ? { innerTransactionHash } : {}),
    };
  }

  /**
   * Parse asset string into Stellar Asset object
   */
  private parseAsset(assetString: string): Asset {
    if (assetString === 'native' || assetString === 'XLM') {
      return Asset.native();
    }

    // Format: "CODE:ISSUER"
    const parts = assetString.split(':');
    if (parts.length !== 2) {
      throw new Error(`Invalid asset format: ${assetString}`);
    }

    const [code, issuer] = parts;
    return new Asset(code, issuer);
  }

  /**
   * Get account balance for verification
   */
  public async getAccountBalance(
    publicKey: string,
    asset: string,
  ): Promise<string> {
    try {
      const account = await this.server.loadAccount(publicKey);
      const parsedAsset = this.parseAsset(asset);
      const balance = account.balances.find((b) => {
        if (parsedAsset.isNative()) {
          return b.asset_type === 'native';
        }
        return (
          b.asset_type !== 'native' &&
          'asset_code' in b &&
          'asset_issuer' in b &&
          b.asset_code === parsedAsset.getCode() &&
          b.asset_issuer === parsedAsset.getIssuer()
        );
      });
      return balance?.balance || '0';
    } catch (error) {
      const typedError = error as HorizonErrorResponse;
      this.logger.error(`Failed to get account balance: ${typedError.message}`);
      throw error;
    }
  }
}
