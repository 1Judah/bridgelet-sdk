import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

/**
 * Identity attached to a request by {@link JwtAuthGuard} (#825).
 *
 * - `admin`  — the caller sees every account (the historical behaviour, and
 *              what a token with no `scope` claim gets, so existing
 *              single-caller deployments keep working).
 * - `sender` — the caller is scoped to one wallet address and only sees
 *              accounts stamped with that `senderAddress`.
 */
export interface AuthenticatedCaller {
  scope: 'admin' | 'sender';
  senderAddress: string | null;
}

/** Caller assumed when a request reaches a handler without one attached. */
export const ADMIN_CALLER: AuthenticatedCaller = {
  scope: 'admin',
  senderAddress: null,
};

type RequestWithCaller = Request & { user?: AuthenticatedCaller };

/**
 * Reads the caller the guard attached to the request. Falls back to the admin
 * scope so handlers invoked directly (unit tests, or a request that somehow
 * bypassed the guard) keep the pre-#825 behaviour.
 */
export function getCallerFromRequest(request: Request): AuthenticatedCaller {
  return (request as RequestWithCaller).user ?? ADMIN_CALLER;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithCaller>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException();
    }

    let caller: AuthenticatedCaller;

    try {
      // #825: a token may carry a `scope` of `sender` plus the wallet
      // `senderAddress` it is scoped to. Any other token (including one with
      // no `scope` claim at all) is treated as an unscoped admin token, which
      // preserves the behaviour existing callers rely on.
      const payload = await this.jwtService.verifyAsync<{
        type?: string;
        scope?: string;
        senderAddress?: string;
      }>(token);

      // #884: require an explicit `type: 'api'`. A claim token is signed with
      // `type: 'claim'`, so presenting one here is rejected rather than being
      // reusable as a general auth bearer token.
      if (payload.type !== 'api') {
        throw new UnauthorizedException();
      }

      if (payload.scope === 'sender') {
        // Fail closed: a sender-scoped token without an address could never be
        // matched against an account, so treat it as invalid rather than
        // silently granting (or withholding) access.
        if (!payload.senderAddress) {
          throw new UnauthorizedException();
        }
        caller = { scope: 'sender', senderAddress: payload.senderAddress };
      } else {
        caller = { scope: 'admin', senderAddress: null };
      }
    } catch {
      throw new UnauthorizedException();
    }

    request.user = caller;

    return true;
  }

  private extractBearerToken(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
