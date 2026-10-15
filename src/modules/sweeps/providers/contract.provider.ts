import {
  Injectable,
  Logger,
  InternalServerErrorException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Contract,
  rpc,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Address,
  xdr,
  hash,
} from '@stellar/stellar-sdk';
import type { AuthorizeSweepParams } from '../interfaces/authorize-sweep-params.interface.js';
import type { ContractAuthResult } from '../interfaces/contract-auth-result.interface.js';
import { SweepSignerUtil } from '../../../common/crypto/sweep-signer.util.js';
import { SweepSigningGuard } from '../../../common/crypto/sweep-signing-guard.util.js';
import {
  createSweepSigner,
  type SweepSigner,
} from '../../../common/crypto/sweep-signer.js';

/**
 * Reported by {@link ContractProvider.getContractInfo} when the deployed
 * contract's version is not configured. Preferred over a hardcoded semver,
 * which silently drifts from the deployed WASM once the contract is
 * redeployed (#648).
 */
export const UNKNOWN_CONTRACT_VERSION = 'unknown';

@Injectable()
export class ContractProvider implements OnModuleInit {
  private readonly logger = new Logger(ContractProvider.name);
  private readonly contractVersion: string;
  private readonly sorobanRpcUrl: string;
  private readonly networkPassphrase: string;

  /**
   * #823: the configured sweep signer (env-seed for development, KMS for
   * production), created once at startup so a misconfigured deployment fails
   * before the first claim rather than during it.
   */
  private sweepSigner: SweepSigner | null = null;

  /**
   * #650: built once per provider, not once per sweep. This provider is
   * registered with Nest's default (singleton) scope, so a single connection
   * is shared process-wide - matching TransactionProvider, which has always
   * built its Horizon server in the constructor.
   */
  private readonly server: rpc.Server;

  constructor(private readonly configService: ConfigService) {
    this.sorobanRpcUrl = this.configService.getOrThrow<string>(
      'stellar.sorobanRpcUrl',
    );

    // #648: sourced from config, not a literal, so the reported version
    // tracks the contract that is actually deployed. `get` (not
    // `getOrThrow`) because an unset version is reported as 'unknown'
    // rather than preventing the service from starting.
    this.contractVersion =
      this.configService.get<string>(
        'stellar.contracts.ephemeralAccountVersion',
      ) ?? UNKNOWN_CONTRACT_VERSION;

    // #729: stellar.config.ts rejects anything but 'mainnet' | 'testnet' at
    // load time. Re-check here so a mis-mocked or bypassed config can't
    // silently fall through to the testnet passphrase.
    const network = this.configService.getOrThrow<string>('stellar.network');
    if (network !== 'mainnet' && network !== 'testnet') {
      throw new Error(
        `Invalid stellar.network "${network}". Expected "mainnet" or "testnet".`,
      );
    }
    this.networkPassphrase =
      network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;

    this.server = new rpc.Server(this.sorobanRpcUrl);

    this.logger.log('Initialized ContractProvider');
  }

  /**
   * #823: select and construct the sweep signer at startup. In production
   * this must resolve to a production-capable signer (KMS); there is
   * deliberately no fallback to the env seed, so a missing production
   * signer fails the app here rather than every claim later.
   */
  async onModuleInit(): Promise<void> {
    this.sweepSigner = await createSweepSigner({
      provider:
        this.configService.get<string>('stellar.sweepSignerProvider') ??
        'env-seed',
      signingKeySeed: this.configService.get<string>(
        'stellar.sweepSigningKeySeed',
      ),
      kmsKeyId: this.configService.get<string>('stellar.sweepKmsKeyId'),
      awsRegion: this.configService.get<string>('app.awsRegion'),
      nodeEnv: process.env.NODE_ENV,
      authorizedSigner: this.configService.get<string>(
        'stellar.sweepAuthorizedSigner',
      ),
    });
    this.logger.log(
      `Sweep signer initialized (public key ${this.sweepSigner.publicKey()})`,
    );
  }

  /**
   * Authorize sweep via smart contract
   * Calls the contract's sweep() function to validate authorization
   */
  public async authorizeSweep(
    params: AuthorizeSweepParams,
  ): Promise<ContractAuthResult> {
    this.logger.log(
      `Authorizing sweep for account: ${params.ephemeralPublicKey}`,
    );

    try {
      // Reuse the shared Soroban RPC connection built in the constructor (#650)
      const server = this.server;

      // #812: the account's own EphemeralAccount instance, passed per call —
      // there is no single shared contract any more.
      const contract = new Contract(params.contractId);

      // Prepare destination address parameter
      const destination = Address.fromString(params.destinationAddress);

      // Generate authorization signature — a real Ed25519 signature (#457).
      // See generateAuthSignature() and the SweepSignerUtil class docs for the
      // exact message format and its cross-language conformance test.
      const authSignature = await this.generateAuthSignature(params);

      // Build contract invocation transaction
      const account = await server.getAccount(params.ephemeralPublicKey);

      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            'sweep',
            destination.toScVal(),
            xdr.ScVal.scvBytes(authSignature),
          ),
        )
        .setTimeout(30)
        .build();

      // Simulate contract call first
      const simulated = await server.simulateTransaction(transaction);

      if (rpc.Api.isSimulationError(simulated)) {
        throw new Error(`Contract simulation failed: ${simulated.error}`);
      }

      // #457 (deliberately out of scope, recorded not fixed): the transaction
      // is built and simulated but NEVER submitted. This is a real and
      // separate gap — until it is submitted, no signature ever reaches the
      // chain and `authorizeSweep()` returns `authorized: true` based only on
      // a successful simulation. Fixing it is a larger change than this issue
      // and was not attempted here. The signature produced above is correct
      // and will be accepted by SweepController::verify_sweep_auth once it is
      // actually submitted.
      this.logger.log('Contract authorization successful');

      // Generate cryptographically secure authorization hash
      const timestamp = Date.now();
      const authHash = this.generateAuthHash(
        params.ephemeralPublicKey,
        params.destinationAddress,
        timestamp,
      );

      return {
        authorized: true,
        hash: authHash,
        timestamp: new Date(timestamp),
      };
    } catch (error) {
      const typedError = error as Error;
      this.logger.error(
        `Contract execution failed: ${typedError.message}`,
        typedError.stack,
      );
      throw new InternalServerErrorException(
        `Contract execution failed: ${typedError.message}`,
      );
    }
  }

  /**
   * Produce the `auth_signature` for a sweep, as a real Ed25519 signature
   * over `SHA256( destination_xdr ‖ nonce_be_u64 ‖ controller_xdr )`.
   *
   * ## #457 — this is real signing, and it is cross-verified
   *
   * This was previously commented as "For MVP, we create a dummy signature"
   * above code that was never a dummy, and the signing itself did not work at
   * all: `SweepSignerUtil.sign()` passed a bare 32-byte Ed25519 seed to
   * `crypto.createPrivateKey({format:'der', type:'pkcs8'})`, which throws
   * `ERR_OSSL_ASN1_TOO_LONG` under OpenSSL 3, so it could never return a
   * signature. Both are fixed. The byte-exact output is now pinned by
   * `src/common/crypto/sweep-signer.util.spec.ts` against vectors generated by
   * bridgelet-core's own `tools/sweep-signer`, so a drift in the wire format
   * fails CI rather than shipping.
   *
   * ## Cross-repo state (criterion 2) — verified, not assumed
   *
   * Checked against bridgelet-core @ 2baeb3ee28c513a3b40e385f38cbd6ee9f543401:
   *
   * - `SweepController::verify_sweep_auth` in
   *   `contracts/sweep_controller/src/authorization.rs` is **fully
   *   implemented**: it reads `authorized_signer` from storage, rebuilds the
   *   message with `construct_sweep_message`, and performs a real
   *   `env.crypto().ed25519_verify(...)`, with nonce-based replay protection
   *   via `increment_sweep_nonce`. So the "real check against a fake signer"
   *   half of the coordinated-placeholder risk is closed on the contract side.
   *
   * - `EphemeralAccount::verify_sweep_authorization` in
   *   `contracts/ephemeral_account/src/lib.rs` **remains a stub**: it ignores
   *   its `_signature` argument entirely and only calls
   *   `controller.require_auth()`. That is a *different* function from the one
   *   this SDK path targets, but it does mean the signature is not yet
   *   enforced on the `EphemeralAccount::sweep` entry point. Closing that is a
   *   bridgelet-core change and is deliberately out of scope here.
   *
   * So this SDK side is no longer the weak half: it produces a signature the
   * SweepController will actually accept. The remaining gap is on the
   * `EphemeralAccount` path, and it is not something this repo can close.
   *
   * ## #823 — the signing key now lives behind a SweepSigner
   *
   * The message digest is still built here (unchanged format, still pinned by
   * the conformance vectors), but the private key that signs it is held by
   * the SweepSigner selected at startup in `onModuleInit()`: the env seed in
   * development, an asymmetric Ed25519 KMS key in production. That is why
   * this method is now async and why the seed is no longer read here.
   */
  public async generateAuthSignature(
    params: AuthorizeSweepParams,
  ): Promise<Buffer> {
    // #457 criterion 3: fail closed rather than let a development/test
    // signing seed be used in a production configuration. Narrow on purpose —
    // see SweepSigningGuard's docs for why this is checked here rather than at
    // bootstrap, and why an unset NODE_ENV is allowed. Kept even though
    // createSweepSigner() also refuses the env-seed signer in production:
    // this catches a NODE_ENV change after boot.
    SweepSigningGuard.assertSigningAllowed(process.env.NODE_ENV);

    if (!this.sweepSigner) {
      throw new Error(
        'SweepSigner is not initialized. ContractProvider.onModuleInit() ' +
          'must run before generateAuthSignature().',
      );
    }

    const sweepControllerContractId = this.configService.getOrThrow<string>(
      'stellar.contracts.sweepController',
    );

    // #812: the nonce comes from the caller, which reads it from the
    // SweepController with StellarService.getSweepNonce(). It is deliberately
    // NOT defaulted here: signing `0n` when the caller forgot to read the real
    // value produced a signature the controller rejects for every sweep after
    // the first one ever executed.
    const message = SweepSignerUtil.buildMessage(
      params.destinationAddress,
      params.nonce,
      sweepControllerContractId,
    );

    return this.sweepSigner.sign(message);
  }

  /**
   * Check contract status and version.
   *
   * `contractId` is the EphemeralAccount instance to report on (#812): it is
   * passed per call because, since #811, there is no single shared
   * EphemeralAccount contract any more — the ID to describe depends on which
   * account the caller is asking about.
   *
   * `version` comes from `stellar.contracts.ephemeralAccountVersion`
   * (`EPHEMERAL_ACCOUNT_CONTRACT_VERSION`) and is
   * {@link UNKNOWN_CONTRACT_VERSION} when that is not configured. It is
   * deliberately not a hardcoded literal: this value is safe to surface on
   * an admin/health endpoint, so it must never claim a version the deployed
   * contract does not have (#648).
   *
   * Verified for #709 (duplicate of the already-resolved #648, fixed in PR #781).
   */
  public getContractInfo(contractId: string): {
    contractId: string;
    version: string;
  } {
    return {
      contractId,
      version: this.contractVersion,
    };
  }
  /**
   * Generate cryptographically secure authorization hash
   * Uses Stellar SDK's SHA-256 hash function for security
   *
   * @param ephemeralKey - The ephemeral account public key
   * @param destination - The destination address for the sweep
   * @param timestamp - Optional timestamp for replay protection (defaults to current time)
   * @returns 64-character hex string of the SHA-256 hash
   */
  public generateAuthHash(
    ephemeralKey: string,
    destination: string,
    timestamp?: number,
  ): string {
    const ts = timestamp ?? Date.now();
    const message = `${ephemeralKey}:${destination}:${ts}`;
    // SDK v17: hash() returns a Uint8Array — Buffer.from(...) restores the
    // hex-encoding argument (Uint8Array.toString() takes no encoding).
    const hashBuffer = hash(Buffer.from(message));
    return Buffer.from(hashBuffer).toString('hex');
  }
}
