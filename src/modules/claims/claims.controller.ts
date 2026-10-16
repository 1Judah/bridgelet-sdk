import {
  Controller,
  Get,
  Param,
  Post,
  Body,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { ClaimsService } from './claims.service.js';
import { ClaimDetailsDto } from './dto/claim-details.dto.js';
import { VerifyClaimDto } from './dto/verify-claim.dto.js';
import { RedeemClaimDto } from './dto/redeem-claim.dto.js';
import { ClaimRedemptionResponseDto } from './dto/claim-redemption-response.dto.js';
import { ClaimVerificationResponseDto } from './dto/claim-verification-response.dto.js';

@ApiTags('claims')
@Controller('claims')
@UseGuards(ThrottlerGuard)
export class ClaimsController {
  constructor(private readonly claimsService: ClaimsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get claim details by ID' })
  @ApiParam({
    name: 'id',
    description: 'Claim UUID',
    type: 'string',
  })
  @ApiResponse({
    status: 200,
    description: 'Claim details retrieved',
    type: ClaimDetailsDto,
  })
  @ApiResponse({ status: 404, description: 'Claim not found' })
  @ApiResponse({ status: 400, description: 'id is not a valid UUID' })
  // `Claim.id` is a uuid column, so a non-UUID path segment reached Postgres as
  // `where: { id }` and surfaced as a 500 driver error instead of a 404. Rejecting
  // it here turns a malformed request into a 400 and documents the shape (#911).
  public async findOne(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ClaimDetailsDto> {
    return this.claimsService.findClaimById(id);
  }

  @Post('verify')
  // Dedicated, tighter limit than the global default: this endpoint accepts a
  // raw claim token and can otherwise be used to enumerate/probe valid tokens.
  // Verified for #704 (duplicate of the already-resolved #643, fixed in PR #772).
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Verify claim token validity' })
  @ApiResponse({
    status: 200,
    description: 'Token is valid and claim is available',
    type: ClaimVerificationResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired token' })
  @ApiResponse({ status: 409, description: 'Claim already redeemed' })
  @ApiResponse({
    status: 400,
    description: 'Account has not received payment or invalid request',
  })
  @ApiBody({ type: VerifyClaimDto })
  public async verifyClaim(
    @Body() verifyClaimDto: VerifyClaimDto,
  ): Promise<ClaimVerificationResponseDto> {
    return this.claimsService.verifyClaimToken(verifyClaimDto.claimToken);
  }

  @Post('redeem')
  // Claim tokens are bearer secrets guarding on-chain fund movement, so this
  // route gets an explicit, tighter limit than the app-wide default
  // (ThrottlerModule.forRoot in app.module.ts) to slow brute-force guessing.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: 'Redeem claim and sweep funds to destination wallet',
  })
  @ApiResponse({
    status: 200,
    description: 'Claim redeemed successfully',
    type: ClaimRedemptionResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired token' })
  @ApiResponse({ status: 400, description: 'Invalid destination address' })
  @ApiResponse({ status: 409, description: 'Claim already redeemed' })
  @ApiBody({ type: RedeemClaimDto })
  public async redeem(
    @Body() redeemClaimDto: RedeemClaimDto,
  ): Promise<ClaimRedemptionResponseDto> {
    return this.claimsService.redeemClaim(
      redeemClaimDto.claimToken,
      redeemClaimDto.destinationAddress,
    );
  }
}
