import { BadRequestException } from '@nestjs/common';
import { StrKey } from '@stellar/stellar-sdk';

/**
 * Options controlling which StrKey encodings {@link StellarAddressValidator}
 * accepts. Defaults are deliberately strict (classic Ed25519 account IDs only).
 */
export interface StellarAddressOptions {
  /**
   * Accept Stellar contract addresses (`C...` StrKey). Off by default: the
   * SDK only ever signs/submits with classic account keys, so accepting a
   * contract address where a signer is expected would silently misroute funds.
   */
  allowContractAddress?: boolean;
  /**
   * Accept muxed accounts (`M...` StrKey). Off by default: a muxed account
   * embeds a payment ID that is meaningless for signing, and the SDK stores
   * the classic `G...` form on `accounts.publicKey`.
   */
  allowMuxedAccount?: boolean;
}

/**
 * StellarAddressValidator
 *
 * The single, authoritative implementation of "is this a Stellar address we
 * accept?". Everything else in the codebase must delegate here rather than
 * re-implementing a StrKey check.
 *
 * ## Relationship to `IsStellarPublicKey`
 *
 * `is-stellar-public-key.validator.ts` exposes the same predicate as a
 * `class-validator` decorator so it can be used on DTO properties. It contains
 * no logic of its own and simply delegates to {@link StellarAddressValidator.isValid}
 * with the strict defaults, because the DTOs it decorates
 * (`CreateWebhookDto`-style funding/recovery inputs) always require a classic
 * Ed25519 account ID. If you need a looser rule (contract address, muxed
 * account) at a call site, call {@link StellarAddressValidator} directly with
 * the relevant option rather than adding a second validator file.
 *
 * Accepted encodings, by default:
 * - `G...` Ed25519 public keys (classic account IDs) — the only encoding the
 *   sweep/sign path and `accounts.publicKey` ever use.
 */
export class StellarAddressValidator {
  /**
   * Checks whether the given address is a Stellar address this service accepts.
   *
   * @param address The address string to validate
   * @param options Which additional StrKey encodings to accept (see
   *   {@link StellarAddressOptions}); defaults to classic Ed25519 only.
   * @returns true if valid, false otherwise. Never throws.
   */
  static isValid(
    address: string,
    options: StellarAddressOptions = {},
  ): boolean {
    if (!address || typeof address !== 'string') return false;
    try {
      if (StrKey.isValidEd25519PublicKey(address)) return true;
      if (options.allowContractAddress && StrKey.isValidContract(address)) {
        return true;
      }
      if (
        options.allowMuxedAccount &&
        StrKey.isValidMed25519PublicKey(address)
      ) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Asserts that the given address is an accepted Stellar address.
   * Throws a BadRequestException if invalid.
   *
   * @param address The address string to validate
   * @param options Which additional StrKey encodings to accept
   * @throws BadRequestException if the address is invalid
   */
  static assertValid(
    address: string,
    options: StellarAddressOptions = {},
  ): void {
    if (!StellarAddressValidator.isValid(address, options)) {
      throw new BadRequestException(`Invalid Stellar address: ${address}`);
    }
  }
}
