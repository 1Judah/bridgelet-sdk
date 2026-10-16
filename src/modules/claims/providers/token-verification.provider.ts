import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { Account } from '../../accounts/entities/account.entity.js';
import { ClaimVerificationResponseDto } from '../dto/claim-verification-response.dto.js';
import { AccountStatus } from '../../accounts/enums/account-status.enum.js';
import { verifyClaimTokenWithRotation } from '../../../common/guards/jwt-rotation.util.js';

const { TokenExpiredError, JsonWebTokenError } = jwt;

interface ClaimTokenPayload {
  publicKey: string;
  type: 'claim';
  iat: number;
  exp: number;
}

@Injectable()
export class TokenVerificationProvider {
  private readonly logger = new Logger(TokenVerificationProvider.name);

  constructor(
    @InjectRepository(Account)
    private readonly accountRepository: Repository<Account>,
    private readonly configService: ConfigService,
  ) {}

  async verifyClaimToken(token: string): Promise<ClaimVerificationResponseDto> {
    this.logger.log('Starting claim token verification');

    try {
      // Decode and verify JWT token
      this.decodeClaimToken(token);

      // Hash the token to look up the associated account
      const tokenHash = this.hashToken(token);

      // Find the account by token hash. deletedAt: IsNull() is explicit
      // here (issue #435 audit) even though @DeleteDateColumn already
      // excludes soft-deleted rows, so a soft-deleted account's claim
      // token can never verify.
      const account = await this.accountRepository.findOne({
        where: { claimTokenHash: tokenHash, deletedAt: IsNull() },
      });

      if (!account) {
        this.logger.warn(`Account not found for token hash: ${tokenHash}`);
        throw new UnauthorizedException('Invalid claim token');
      }

      // Validate account status
      this.validateAccountStatus(account);

      // Check if current time hasn't exceeded the account's expiry time.
      //
      // #839: `CLAIM_TOKEN_EXPIRY` (default 2592000s / 30 days) can be longer
      // than the account's own `expiresAt`, so a JWT can still be
      // cryptographically valid after the account has expired. This check is
      // what actually rejects such a token - verification does not rely on a
      // downstream 404 to catch an expired account.
      if (new Date() > account.expiresAt) {
        this.logger.warn(
          `Account ${account.id} has expired at ${account.expiresAt.toISOString()}`,
        );
        throw new UnauthorizedException('Claim token has expired');
      }

      this.logger.log(
        `Claim token verified successfully for account: ${account.id}`,
      );

      return {
        valid: true,
        accountId: account.id,
        amount: account.amount,
        asset: account.asset,
        expiresAt: account.expiresAt,
      };
    } catch (error) {
      if (
        error instanceof UnauthorizedException ||
        error instanceof ConflictException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      this.logger.error('Unexpected error during token verification', error);
      throw error;
    }
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private decodeClaimToken(token: string): ClaimTokenPayload {
    try {
      const jwtSecret = this.configService.getOrThrow<string>('JWT_SECRET');

      // Verifies against the active secret, falling back to JWT_SECRET_PREVIOUS
      // while a rotation window is open (issue #683). Claim tokens can be valid
      // for up to CLAIM_TOKEN_EXPIRY, so a rotation without a grace window
      // would strand every unclaimed token in flight.
      const payload = verifyClaimTokenWithRotation<ClaimTokenPayload>(
        token,
        jwtSecret,
      );

      // Verify token type is 'claim'
      if (payload.type !== 'claim') {
        this.logger.warn(`Invalid token type: ${String(payload.type)}`);
        throw new UnauthorizedException('Invalid token type');
      }

      return payload;
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        this.logger.warn('Token has expired');
        throw new UnauthorizedException('Token has expired');
      }

      if (error instanceof JsonWebTokenError) {
        this.logger.warn('Invalid token signature');
        throw new UnauthorizedException('Invalid token signature');
      }

      throw error;
    }
  }

  private validateAccountStatus(account: Account): void {
    switch (account.status) {
      case AccountStatus.INITIALIZING:
        this.logger.warn(`Account ${account.id} is still being initialized`);
        throw new BadRequestException(
          `This account is still being set up` +
            `Please wait a few seconds and try again`,
        );
      case AccountStatus.CLAIMED:
        this.logger.warn(`Account ${account.id} has already been claimed`);
        throw new ConflictException('Claim has already been redeemed');

      case AccountStatus.EXPIRED:
        this.logger.warn(`Account ${account.id} has expired`);
        throw new UnauthorizedException('Account has expired');

      case AccountStatus.PENDING_PAYMENT:
        this.logger.warn(`Account ${account.id} has not received payment`);
        throw new BadRequestException('Account has not received payment');

      case AccountStatus.FAILED:
        this.logger.warn(`Account ${account.id} is in failed state`);
        throw new BadRequestException('Account is in failed state');

      case AccountStatus.PENDING_CLAIM:
        // This is the expected status for claim verification
        break;

      default:
        this.logger.warn(`Unknown account status: ${String(account.status)}`);
        throw new BadRequestException('Invalid account status');
    }
  }
}
