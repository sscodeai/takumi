/**
 * 認証・認可ミドルウェア（基本設計書 6.3 認可の実装方針）
 */

import type { NextFunction, Request, Response } from 'express';
import { AuthenticationError, AuthorizationError } from '../domain/errors.ts';
import type { AuthClaims, Role } from '../domain/types.ts';
import type { TokenService } from '../auth/token.ts';

/** リクエストに認証済みクレームを付与するための型拡張 */
export interface AuthenticatedRequest extends Request {
  auth?: AuthClaims;
}

export function createAuthMiddleware(tokens: TokenService) {
  return function authMiddleware(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      next(new AuthenticationError('認証が必要です'));
      return;
    }
    const token = header.slice('Bearer '.length).trim();
    try {
      req.auth = tokens.verify(token);
      next();
    } catch {
      next(new AuthenticationError('認証情報が無効です'));
    }
  };
}

/** ロールベースのアクセス制御ガード */
export function requireRoles(...roles: Role[]) {
  return function roleGuard(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
    const auth = req.auth;
    if (!auth) {
      next(new AuthenticationError('認証が必要です'));
      return;
    }
    if (!roles.includes(auth.role)) {
      next(new AuthorizationError('この操作を実行する権限がありません'));
      return;
    }
    next();
  };
}
