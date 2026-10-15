import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard.js';

interface MockRequest {
  headers: { authorization?: string };
  user?: unknown;
}

const mockRequest = (authHeader?: string): MockRequest => ({
  headers: { authorization: authHeader },
});

const mockExecutionContext = (
  authHeader?: string,
  request: MockRequest = mockRequest(authHeader),
): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  }) as unknown as ExecutionContext;

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: jest.Mocked<JwtService>;

  beforeEach(() => {
    jwtService = {
      verifyAsync: jest.fn(),
    } as unknown as jest.Mocked<JwtService>;
    guard = new JwtAuthGuard(jwtService);
  });

  it('allows request with a valid Bearer token', async () => {
    jwtService.verifyAsync.mockResolvedValueOnce({ sub: '1', type: 'api' });
    await expect(
      guard.canActivate(mockExecutionContext('Bearer valid.token')),
    ).resolves.toBe(true);
  });

  it('rejects a claim token on an API route', async () => {
    jwtService.verifyAsync.mockResolvedValueOnce({
      publicKey: 'GABC',
      type: 'claim',
    });
    await expect(
      guard.canActivate(mockExecutionContext('Bearer claim.token')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws 401 when Authorization header is missing', async () => {
    await expect(guard.canActivate(mockExecutionContext())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws 401 when scheme is not Bearer', async () => {
    await expect(
      guard.canActivate(mockExecutionContext('Basic sometoken')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws 401 when token is expired', async () => {
    jwtService.verifyAsync.mockRejectedValueOnce(
      new Error('TokenExpiredError'),
    );
    await expect(
      guard.canActivate(mockExecutionContext('Bearer expired.token')),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('throws 401 when token signature is invalid', async () => {
    jwtService.verifyAsync.mockRejectedValueOnce(
      new Error('JsonWebTokenError'),
    );
    await expect(
      guard.canActivate(mockExecutionContext('Bearer bad.signature')),
    ).rejects.toThrow(UnauthorizedException);
  });

  // #825: scope extraction
  it('treats a token with no scope claim as admin', async () => {
    jwtService.verifyAsync.mockResolvedValueOnce({ type: 'api' });
    const request = mockRequest('Bearer valid.token');

    await expect(
      guard.canActivate(mockExecutionContext('Bearer valid.token', request)),
    ).resolves.toBe(true);
    expect(request.user).toEqual({ scope: 'admin', senderAddress: null });
  });

  it('attaches the sender address for a sender-scoped token', async () => {
    const senderAddress = 'G' + 'A'.repeat(55);
    jwtService.verifyAsync.mockResolvedValueOnce({
      type: 'api',
      scope: 'sender',
      senderAddress,
    });
    const request = mockRequest('Bearer valid.token');

    await expect(
      guard.canActivate(mockExecutionContext('Bearer valid.token', request)),
    ).resolves.toBe(true);
    expect(request.user).toEqual({ scope: 'sender', senderAddress });
  });

  it('rejects a sender-scoped token with no sender address', async () => {
    jwtService.verifyAsync.mockResolvedValueOnce({
      type: 'api',
      scope: 'sender',
    });

    await expect(
      guard.canActivate(mockExecutionContext('Bearer valid.token')),
    ).rejects.toThrow(UnauthorizedException);
  });
});
