import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus } from '../enums/account-status.enum.js';

export class AccountResponseDto {
  @ApiProperty({
    description:
      'Unique identifier for the account record in the Bridgelet system',
    example: '550e8400-e29b-41d4-a716-446655440000',
    format: 'uuid',
    readOnly: true,
  })
  accountId: string;

  @ApiProperty({
    description:
      'Stellar public key (account address) for this ephemeral account',
    example: 'GABCD1234EFGH5678IJKL9012MNOP3456QRST7890UVWX1234YZAB5678',
    format: 'stellar-public-key',
    pattern: '^[G][A-Z0-9]{55}$',
    readOnly: true,
  })
  publicKey: string;

  @ApiProperty({
    description:
      'Stellar public key of the sender who created this account, or null ' +
      'for accounts created without a sender identity. Drives the scoping of ' +
      'GET /accounts and GET /accounts/:id (#825).',
    example: 'GSENDER1234EFGH5678IJKL9012MNOP3456QRST7890UVWX1234YZAB5678',
    format: 'stellar-public-key',
    pattern: '^[G][A-Z0-9]{55}$',
    nullable: true,
    readOnly: true,
  })
  senderAddress: string | null;

  @ApiProperty({
    description:
      'URL for claiming funds from this account. Null if account is already claimed or expired.',
    example: 'https://bridgelet.app/claim/abc123def456',
    format: 'uri',
    nullable: true,
    readOnly: true,
  })
  claimUrl: string | null;

  @ApiProperty({
    description:
      'Transaction hash of the funding transaction that created this account',
    example: 'abcd1234efgh5678ijkl9012mnop3456qrst7890uvwx1234yzab5678',
    format: 'hex',
    pattern: '^[a-fA-F0-9]{64}$',
    readOnly: true,
  })
  txHash?: string;

  @ApiProperty({
    description:
      'Amount of funds in the account, represented as a decimal string to preserve precision',
    example: '100.5000000',
    format: 'decimal',
    pattern: '^d+.d{7}$',
    readOnly: true,
  })
  amount: string;

  @ApiProperty({
    description: 'Asset code for the funds in this account (e.g., XLM, USDC)',
    example: 'XLM',
    maxLength: 100,
    readOnly: true,
  })
  asset: string;

  @ApiProperty({
    description: 'Current lifecycle status of the account',
    enum: AccountStatus,
    example: AccountStatus.PENDING_CLAIM,
    readOnly: true,
  })
  status: AccountStatus;

  @ApiProperty({
    description: 'Timestamp when this account will expire and become unusable',
    example: '2026-03-26T10:00:00.000Z',
    format: 'date-time',
    readOnly: true,
  })
  expiresAt: Date;

  @ApiProperty({
    description: 'Timestamp when this account record was created in the system',
    example: '2026-02-26T10:00:00.000Z',
    format: 'date-time',
    readOnly: true,
  })
  createdAt: Date;

  @ApiProperty({
    description:
      'Timestamp when funds were claimed from this account. Null if not yet claimed.',
    example: '2026-02-26T10:30:00.000Z',
    format: 'date-time',
    nullable: true,
    readOnly: true,
  })
  claimedAt?: Date | null;

  @ApiProperty({
    description:
      'Destination Stellar address where funds were swept to. Present only after successful claim.',
    example: 'GZYX9876VWUT5432SRQP1098NOML7654KJIH3210FEDC9876BAZYXWVU',
    format: 'stellar-public-key',
    pattern: '^[G][A-Z0-9]{55}$',
    readOnly: true,
  })
  destination?: string;

  @ApiProperty({
    description:
      'Optional metadata associated with this account. Structure varies by integration.',
    example: {
      integration_id: 'webhook_123',
      customer_reference: 'cust_456',
      callback_url: 'https://example.com/webhook',
    },
    type: 'object',
    additionalProperties: true,
    readOnly: true,
  })
  metadata?: Record<string, any>;
}
