import { BadRequestException } from '@nestjs/common';
import { StrKey } from '@stellar/stellar-sdk';
import { StellarAddressValidator } from './stellar-address.validator.js';

describe('StellarAddressValidator', () => {
  const validAddress =
    'GDV3BRGE2BXK5JMGAEDGE5QWAY2DBK5V2KEG762Y5GH4LPC5RSPRPTTJ';
  const wrongPrefix =
    'ADV3BRGE2BXK5JMGAEDGE5QWAY2DBK5V2KEG762Y5GH4LPC5RSPRPTTJ';
  const wrongLength = 'GDV3BRGE2BXK5JMGAEDGE5QWAY2DBK5V2KEG762Y5GH4LPC5RSPRPTT'; // Too short
  const invalidChecksum =
    'GDV3BRGE2BXK5JMGAEDGE5QWAY2DBK5V2KEG762Y5GH4LPC5RSPRPTTA'; // Tampered last char
  const isValidLoose = StellarAddressValidator.isValid;

  describe('isValid', () => {
    it('should return true for a valid address', () => {
      expect(StellarAddressValidator.isValid(validAddress)).toBe(true);
    });

    it('should return false for an address with wrong prefix', () => {
      expect(StellarAddressValidator.isValid(wrongPrefix)).toBe(false);
    });

    it('should return false for an address with wrong length', () => {
      expect(StellarAddressValidator.isValid(wrongLength)).toBe(false);
    });

    it('should return false for an address with an invalid checksum', () => {
      expect(StellarAddressValidator.isValid(invalidChecksum)).toBe(false);
    });

    it('should return false for an empty string', () => {
      expect(StellarAddressValidator.isValid('')).toBe(false);
    });

    it('should return false for undefined or null inputs', () => {
      expect(isValidLoose(undefined)).toBe(false);
      expect(isValidLoose(null)).toBe(false);
    });
  });

  // ── optional StrKey encodings (issue #671) ─────────────────────────────────

  describe('optional StrKey encodings', () => {
    // Contract addresses and muxed accounts are rejected under the strict
    // defaults, because the signing/sweep path only ever handles classic
    // Ed25519 account IDs.
    const contractAddress = StrKey.encodeContract(Buffer.alloc(32, 7));
    // SDK v17: encodeMed25519PublicKey takes the raw 40-byte payload
    // (32-byte Ed25519 key + 8-byte big-endian muxed ID) in one argument.
    const muxedId = Buffer.alloc(8);
    muxedId.writeBigUInt64BE(12345n);
    const muxedAccount = StrKey.encodeMed25519PublicKey(
      Buffer.concat([Buffer.alloc(32, 9), muxedId]),
    );

    it('rejects a contract address by default', () => {
      expect(StellarAddressValidator.isValid(contractAddress)).toBe(false);
    });

    it('accepts a contract address when allowContractAddress is set', () => {
      expect(
        StellarAddressValidator.isValid(contractAddress, {
          allowContractAddress: true,
        }),
      ).toBe(true);
    });

    it('rejects a muxed account by default', () => {
      expect(StellarAddressValidator.isValid(muxedAccount)).toBe(false);
    });

    it('accepts a muxed account when allowMuxedAccount is set', () => {
      expect(
        StellarAddressValidator.isValid(muxedAccount, {
          allowMuxedAccount: true,
        }),
      ).toBe(true);
    });

    it('does not let one option leak into the other encoding', () => {
      expect(
        StellarAddressValidator.isValid(muxedAccount, {
          allowContractAddress: true,
        }),
      ).toBe(false);
      expect(
        StellarAddressValidator.isValid(contractAddress, {
          allowMuxedAccount: true,
        }),
      ).toBe(false);
    });

    it('assertValid honours the same options', () => {
      expect(() =>
        StellarAddressValidator.assertValid(contractAddress, {
          allowContractAddress: true,
        }),
      ).not.toThrow();
      expect(() =>
        StellarAddressValidator.assertValid(contractAddress),
      ).toThrow(BadRequestException);
    });
  });

  describe('assertValid', () => {
    it('should not throw for a valid address', () => {
      expect(() =>
        StellarAddressValidator.assertValid(validAddress),
      ).not.toThrow();
    });

    it('should throw BadRequestException for invalid addresses', () => {
      const invalidAddresses = [wrongPrefix, wrongLength, invalidChecksum, ''];

      invalidAddresses.forEach((address) => {
        expect(() => StellarAddressValidator.assertValid(address)).toThrow(
          BadRequestException,
        );
        expect(() => StellarAddressValidator.assertValid(address)).toThrow(
          `Invalid Stellar address: ${address}`,
        );
      });
    });
  });
});
