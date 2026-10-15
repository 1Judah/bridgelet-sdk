import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Claim } from '../entities/claim.entity.js';
import { ClaimDetailsDto } from '../dto/claim-details.dto.js';

@Injectable()
export class ClaimLookupProvider {
  private readonly logger = new Logger(ClaimLookupProvider.name);

  constructor(
    @InjectRepository(Claim)
    private readonly claimsRepository: Repository<Claim>,
  ) {}

  async findClaimById(id: string): Promise<ClaimDetailsDto> {
    this.logger.log(`Looking up claim: ${id}`);

    // Issue #435 audit note: `relations: ['account']` performs a LEFT JOIN,
    // and TypeORM's automatic `deletedAt IS NULL` filter only applies to
    // the query's main alias (this Claim), not to joined relations. This
    // is intentional here: a claim is a historical record that should
    // remain visible even if the underlying account was later soft-deleted
    // (e.g. by an admin cleanup). This method never uses the joined
    // `account` to authorize a claim or sweep action, so it cannot be
    // used to bypass the soft-delete on those paths.
    //
    // Verified for #703 (duplicate of the already-resolved #642, fixed in
    // PR #774) and re-verified for #764: this method looks the claim up by
    // primary key (`claims.id` -> PK_claims) and follows the `account`
    // relation by primary key (`accounts.id` -> PK_accounts), so neither side
    // of the query can fall back to a sequential scan. Note that the
    // `claimTokenHash` index (`IDX_accounts_claimTokenHash`, from
    // CreateAccountsTable) serves the redemption/verification lookups in
    // `claim-redemption.provider.ts` and `token-verification.provider.ts` --
    // not this query, which joins on `accountId` and never touches
    // `claimTokenHash`. Real-Postgres plan assertions for all three shapes
    // live in `test/claim-lookup-index.e2e-spec.ts`.
    const claim = await this.claimsRepository.findOne({
      where: { id },
      relations: ['account'],
    });

    if (!claim) {
      this.logger.warn(`Claim ${id} not found`);
      throw new NotFoundException(`Claim ${id} not found`);
    }

    this.logger.log(`Claim ${id} retrieved successfully`);

    return {
      id: claim.id,
      accountId: claim.accountId,
      destinationAddress: claim.destinationAddress,
      amountSwept: claim.amountSwept,
      asset: claim.asset,
      sweepTxHash: claim.sweepTxHash,
      claimedAt: claim.claimedAt,
    };
  }
}
