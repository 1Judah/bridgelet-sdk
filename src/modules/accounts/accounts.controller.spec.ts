import { Test, TestingModule } from '@nestjs/testing';
import { Request } from 'express';
import { AccountsController } from './accounts.controller.js';
import { AccountsService } from './accounts.service.js';
import { AccountStatus } from './enums/account-status.enum.js';
import { CreateAccountDto } from './dto/create-account.dto.js';
import { AccountResponseDto } from './dto/account-response.dto.js';
import {
  ADMIN_CALLER,
  AuthenticatedCaller,
  JwtAuthGuard,
} from '../../common/guards/jwt-auth.guard.js';
import { ThrottlerGuard } from '@nestjs/throttler';

const VALID_KEY = 'G' + 'A'.repeat(55);
const SENDER_A = 'G' + 'C'.repeat(55);

const mockAccountsService = {
  create: jest.fn(),
  findOne: jest.fn(),
  findAll: jest.fn(),
};

function makeRequest(caller: AuthenticatedCaller = ADMIN_CALLER): Request {
  return { user: caller } as unknown as Request;
}

function makeResponse(overrides = {}): AccountResponseDto {
  return {
    accountId: 'uuid-1',
    publicKey: VALID_KEY,
    senderAddress: null,
    claimUrl: 'https://claim.bridgelet.io/c/token',
    txHash: 'txhash',
    amount: '100',
    asset: 'native',
    status: AccountStatus.PENDING_PAYMENT,
    expiresAt: new Date('2099-01-01'),
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('AccountsController', () => {
  let controller: AccountsController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountsController],
      providers: [{ provide: AccountsService, useValue: mockAccountsService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AccountsController>(AccountsController);
  });

  describe('create', () => {
    it('delegates to accountsService.create and returns the result', async () => {
      const dto: CreateAccountDto = {
        fundingSource: VALID_KEY,
        amount: '100',
        asset: 'native',
        expiresIn: 3600,
      };
      const response = makeResponse();
      mockAccountsService.create.mockResolvedValue(response);

      const result = await controller.create(dto, makeRequest());

      expect(mockAccountsService.create).toHaveBeenCalledWith(
        dto,
        ADMIN_CALLER,
      );
      expect(result).toBe(response);
    });

    it('forwards the sender-scoped caller to the service (#825)', async () => {
      const dto: CreateAccountDto = {
        fundingSource: VALID_KEY,
        amount: '100',
        asset: 'native',
        expiresIn: 3600,
      };
      const senderCaller: AuthenticatedCaller = {
        scope: 'sender',
        senderAddress: SENDER_A,
      };
      mockAccountsService.create.mockResolvedValue(makeResponse());

      await controller.create(dto, makeRequest(senderCaller));

      expect(mockAccountsService.create).toHaveBeenCalledWith(
        dto,
        senderCaller,
      );
    });
  });

  describe('findOne', () => {
    it('delegates to accountsService.findOne with the given id', async () => {
      const response = makeResponse();
      mockAccountsService.findOne.mockResolvedValue(response);

      const result = await controller.findOne('uuid-1', makeRequest());

      expect(mockAccountsService.findOne).toHaveBeenCalledWith(
        'uuid-1',
        ADMIN_CALLER,
      );
      expect(result).toBe(response);
    });
  });

  describe('findAll', () => {
    it('delegates to accountsService.findAll with default pagination', async () => {
      const response = { accounts: [makeResponse()], total: 1 };
      mockAccountsService.findAll.mockResolvedValue(response);

      const result = await controller.findAll(makeRequest());

      expect(mockAccountsService.findAll).toHaveBeenCalledWith(
        {
          status: undefined,
          limit: 50,
          offset: 0,
        },
        ADMIN_CALLER,
      );
      expect(result).toBe(response);
    });

    it('passes status filter and custom pagination params', async () => {
      const response = { accounts: [], total: 0 };
      mockAccountsService.findAll.mockResolvedValue(response);

      await controller.findAll(makeRequest(), AccountStatus.EXPIRED, 10, 20);

      expect(mockAccountsService.findAll).toHaveBeenCalledWith(
        {
          status: AccountStatus.EXPIRED,
          limit: 10,
          offset: 20,
        },
        ADMIN_CALLER,
      );
    });
  });
});
