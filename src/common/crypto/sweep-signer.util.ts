import * as crypto from 'crypto';
import { Address, Keypair } from '@stellar/stellar-sdk';

/**
 * SweepSignerUtil
 *
 * Produces Ed25519 signatures for sweep authorization that match the
 * message format verified on-chain by SweepController.authorization.rs.
 *
 * Message format (mirrors construct_sweep_message in bridgelet-core):
 *   SHA256( destination_xdr_bytes | nonce_u64_big_endian | contract_id_xdr_bytes )
 *
 * The signing key must be the Ed25519 private key whose corresponding
 * public key was registered in SweepController.initialize() as authorized_signer.
 *
 * Key format: 64-byte hex string (32-byte seed || 32-byte public key),
 * as produced by Stellar Keypair.rawSecretKey() + Keypair.rawPublicKey().
 * Alternatively, supply the raw 32-byte seed as a 64-character hex string.
 *
 * Cross-language conformance (#457)
 * --------------------------------
 * The byte-exact output of `buildMessage` and `sign` is pinned by
 * `sweep-signer.util.spec.ts` against vectors produced by bridgelet-core's
 * own signer, `tools/sweep-signer` (which uses `soroban_sdk::Address::to_xdr()`
 * and `env.crypto().sha256()` - the same primitives the deployed contract
 * uses). A change to `construct_sweep_message` in bridgelet-core invalidates
 * those vectors and they must be regenerated; see the spec for the exact
 * command.
 */

/**
 * DER prefix for a PKCS#8-wrapped Ed25519 private key:
 * SEQUENCE(46) { INTEGER 0, SEQUENCE(6) { OID 1.3.101.112 }, OCTET STRING(32) }.
 * The 32-byte Ed25519 seed is appended verbatim to this.
 */
const PKCS8_ED25519_HEADER = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

export class SweepSignerUtil {
  /**
   * Sign a sweep authorization for the given destination and nonce.
   *
   * @param destinationStrKey  - Stellar G... address of the sweep destination
   * @param nonce              - Current sweep nonce from SweepController storage
   * @param sweepControllerContractId - C... address of the deployed SweepController
   * @param signingKeySeed     - 32-byte Ed25519 seed as 64-char hex string
   * @returns 64-byte signature as a Buffer
   */
  static sign(
    destinationStrKey: string,
    nonce: bigint,
    sweepControllerContractId: string,
    signingKeySeed: string,
  ): Buffer {
    const message = SweepSignerUtil.buildMessage(
      destinationStrKey,
      nonce,
      sweepControllerContractId,
    );

    return SweepSignerUtil.signMessage(message, signingKeySeed);
  }

  /**
   * Sign a pre-built message digest (the 32-byte SHA256 output of
   * {@link buildMessage}). Split out of `sign()` so `EnvSeedSweepSigner`
   * (#823) can sign through the `SweepSigner` interface without
   * re-deriving destination/nonce/controller; the bytes are identical.
   */
  static signMessage(message: Buffer, signingKeySeed: string): Buffer {
    const seed = Buffer.from(signingKeySeed, 'hex');
    if (seed.length !== 32) {
      throw new Error(
        `Signing key seed must be 32 bytes (64 hex chars). Got ${seed.length} bytes.`,
      );
    }

    // #457: the raw 32-byte seed is NOT a PKCS#8 document. Passing it
    // directly to createPrivateKey({format:'der', type:'pkcs8'}) throws
    // ERR_OSSL_ASN1_TOO_LONG under OpenSSL 3, so `sign()` previously never
    // produced a signature at all - it only ever failed. Ed25519 PKCS#8 is a
    // fixed 16-byte header followed by the raw 32-byte seed, so wrap it here
    // rather than relying on the caller to hand us an already-wrapped key.
    const pkcs8 = Buffer.concat([PKCS8_ED25519_HEADER, seed]);

    const privateKey = crypto.createPrivateKey({
      key: pkcs8,
      format: 'der',
      type: 'pkcs8',
    });

    // Ed25519 is deterministic and signs the raw 32-byte digest (RFC 8032),
    // which is exactly what env.crypto().ed25519_verify() in bridgelet-core
    // consumes. `null` algorithm = Ed25519 (unlike ECDSA, no prehash step).
    return crypto.sign(null, message, privateKey);
  }

  /**
   * The G... strkey of the public key a 32-byte Ed25519 seed derives.
   * Used by {@link EnvSeedSweepSigner} (#823) to report the key a signer
   * signs with, so it can be compared against the SweepController's
   * on-chain `authorized_signer`.
   */
  static publicKeyFromSeed(signingKeySeed: string): string {
    const seed = Buffer.from(signingKeySeed, 'hex');
    if (seed.length !== 32) {
      throw new Error(
        `Signing key seed must be 32 bytes (64 hex chars). Got ${seed.length} bytes.`,
      );
    }
    return Keypair.fromRawEd25519Seed(seed).publicKey();
  }

  /**
   * Reconstruct the exact message bytes that the on-chain contract hashes.
   * Must stay in sync with construct_sweep_message() in:
   * bridgelet-core/contracts/sweep_controller/src/authorization.rs
   */
  static buildMessage(
    destinationStrKey: string,
    nonce: bigint,
    sweepControllerContractId: string,
  ): Buffer {
    // XDR-encode the destination address (Stellar SDK ScVal encoding)
    // Soroban Address.to_xdr() serializes as an AccountId ScVal
    const destXdr = encodeAddressToXdr(destinationStrKey);
    const contractXdr = encodeAddressToXdr(sweepControllerContractId);

    // Encode nonce as 8-byte big-endian u64
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64BE(nonce);

    const combined = Buffer.concat([destXdr, nonceBuf, contractXdr]);

    // SHA256 hash — mirrors env.crypto().sha256() in Soroban
    return crypto.createHash('sha256').update(combined).digest();
  }
}

/**
 * Minimal XDR encoding for a Stellar StrKey address as Soroban serializes it.
 * Soroban's Address.to_xdr() produces an ScVal of type SCV_ADDRESS containing
 * an AccountId (for G... keys) or ContractId (for C... keys).
 *
 * Use @stellar/stellar-sdk's xdr module for correctness — do not hand-roll.
 */
function encodeAddressToXdr(strKey: string): Buffer {
  const scVal = Address.fromString(strKey).toScVal();
  return Buffer.from(scVal.toXDR());
}
