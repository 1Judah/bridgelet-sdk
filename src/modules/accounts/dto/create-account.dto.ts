import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsObject,
  Min,
  Max,
  ValidateIf,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsStellarPublicKey } from '../../../common/validators/is-stellar-public-key.validator.js';
import { IsBoundedMetadata } from '../../../common/validators/is-bounded-metadata.validator.js';

// 'native' should be added to regex in the future.
const ASSET_CODE_REGEX = /^[A-Z0-9]{1,12}$/;
const ASSET_ISSUER_REGEX = /^G[A-Z0-9]{55}$/;

export class CreateAccountDto {
  @ApiProperty({
    example: 'GSENDER...',
    description:
      'Stellar public key of the funding account. Must be 56 characters, ' +
      'start with G, and contain only uppercase alphanumeric characters.',
  })
  @IsString()
  @IsNotEmpty()
  @IsStellarPublicKey()
  fundingSource: string;

  @ApiProperty({
    example: 'GRECOVERY...',
    description:
      'Stellar public key to recover funds to if the ephemeral account expires unclaimed. ' +
      'Must be 56 characters, start with G, and contain only uppercase alphanumeric characters.',
  })
  @IsString()
  @IsNotEmpty()
  @IsStellarPublicKey()
  recovery_address: string;

  @ApiProperty({ example: '100', description: 'Payment amount' })
  @IsString()
  @IsNotEmpty()
  amount: string;

  @ApiProperty({
    example: 'USDC',
    description:
      'Asset code (1–12 uppercase alphanumeric characters). ' +
      'Use "native" for XLM. Required when asset_issuer is provided.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(ASSET_CODE_REGEX, {
    message:
      'asset_code must be 1–12 uppercase alphanumeric characters (e.g. USDC, XLM)',
  })
  asset_code?: string;

  @ApiProperty({
    example: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    description:
      'Stellar public key of the asset issuer. Required when asset_code is a non-native issued asset.',
    required: false,
  })
  @ValidateIf((o: CreateAccountDto) => !!o.asset_code && o.asset_code !== 'XLM')
  @IsString()
  @IsNotEmpty()
  @Matches(ASSET_ISSUER_REGEX, {
    message:
      'asset_issuer must be a valid Stellar public key (56 characters, starts with G)',
  })
  asset_issuer?: string;

  @ApiProperty({
    example: 'GSENDER...',
    description:
      'Stellar public key of the sender who owns this account. Used to scope ' +
      'GET /accounts and GET /accounts/:id for sender-scoped API tokens. ' +
      'Optional: a sender-scoped token always stamps its own address, and an ' +
      'admin token may leave it unset.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsStellarPublicKey()
  senderAddress?: string;

  @ApiProperty({
    example: 2592000,
    description: 'Expiry in seconds (1 hour - 30 days)',
  })
  @IsNumber()
  @Min(3600) // 1 hour
  @Max(2592000) // 30 days
  expiresIn: number;

  @ApiProperty({ example: { userId: 'user_123' }, required: false })
  @IsOptional()
  @IsObject()
  @IsBoundedMetadata()
  metadata?: Record<string, any>;
}
