import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AccountsService } from './accounts.service.js';
import { CreateAccountDto } from './dto/create-account.dto.js';
import { AccountResponseDto } from './dto/account-response.dto.js';
import { AccountsListResponseDto } from './dto/accounts-list-response.dto.js';
import { AccountStatus } from './enums/account-status.enum.js';
import {
  getCallerFromRequest,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard.js';

@ApiTags('accounts')
@ApiBearerAuth()
@Controller('accounts')
@UseGuards(ThrottlerGuard, JwtAuthGuard)
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create ephemeral escrow account',
    description:
      'Creates a temporary Stellar escrow account for fund holding. ' +
      'This is NOT a user wallet — it is an ephemeral account that will be ' +
      'swept to a destination address upon claim or expire after the set duration. ' +
      'Returns claim URL for the recipient to access funds.',
  })
  @ApiResponse({
    status: 201,
    description: 'Ephemeral account created successfully',
    type: AccountResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid input parameters' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded — requests are throttled to protect funding flows',
  })
  @ApiBody({ type: CreateAccountDto })
  public async create(
    @Body() createAccountDto: CreateAccountDto,
    @Req() req: Request,
  ): Promise<AccountResponseDto> {
    return this.accountsService.create(
      createAccountDto,
      getCallerFromRequest(req),
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get ephemeral account lifecycle state',
    description:
      'Retrieves the current state of an ephemeral account including its ' +
      'status (pending_payment, pending_claim, claimed, expired, failed), ' +
      'funding details, and claim information.',
  })
  @ApiResponse({
    status: 200,
    description: 'Account details retrieved successfully',
    type: AccountResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded — requests are throttled to protect funding flows',
  })
  public async findOne(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<AccountResponseDto> {
    return this.accountsService.findOne(id, getCallerFromRequest(req));
  }

  @Get()
  @ApiOperation({
    summary: 'List ephemeral accounts',
    description:
      'Lists ephemeral accounts with optional filtering. An admin-scoped token ' +
      'sees every account; a sender-scoped token only sees accounts stamped with ' +
      'its own sender address (#825). Supports filtering by status and ' +
      'offset-based pagination using limit/offset. Maximum 100 records per request.',
  })
  @ApiQuery({
    name: 'status',
    enum: AccountStatus,
    required: false,
    description:
      'Filter accounts by lifecycle status:\n' +
      '- `pending_payment`: Account created, awaiting funding\n' +
      '- `pending_claim`: Funded and ready for recipient claim\n' +
      '- `claimed`: Funds successfully transferred to recipient\n' +
      '- `expired`: Claim window closed, funds swept back\n' +
      '- `failed`: Error during creation or funding',
  })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: 'Maximum number of records to return (default: 50, max: 100)',
    example: 50,
  })
  @ApiQuery({
    name: 'offset',
    type: Number,
    required: false,
    description:
      'Number of records to skip for offset-based pagination. ' +
      'Use with limit to paginate through results. Not page-based.',
    example: 0,
  })
  @ApiResponse({
    status: 200,
    description: 'List of accounts retrieved successfully',
    type: AccountsListResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded — requests are throttled to protect funding flows',
  })
  public async findAll(
    @Req() req: Request,
    @Query('status') status?: AccountStatus,
    @Query('limit') limit = 50,
    @Query('offset') offset = 0,
  ): Promise<AccountsListResponseDto> {
    return this.accountsService.findAll(
      { status, limit, offset },
      getCallerFromRequest(req),
    );
  }
}
