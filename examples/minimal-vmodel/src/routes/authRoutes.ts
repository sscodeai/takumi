/**
 * 認証ルート（基本設計書 4.2 エンドポイント No.1 / No.2）
 */

import { Router } from 'express';
import type { AuthService } from '../auth/authService.ts';
import { createAuthMiddleware } from '../middleware/authMiddleware.ts';
import type { TokenService } from '../auth/token.ts';
import type { AuthenticatedRequest } from '../middleware/authMiddleware.ts';

export function createAuthRouter(authService: AuthService, tokens: TokenService): Router {
  const router = Router();

  // POST /api/auth/login（認証不要）
  router.post('/login', async (req, res, next) => {
    try {
      const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
      const result = await authService.login(username, password);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/auth/logout（認証済み）
  const auth = createAuthMiddleware(tokens);
  router.post('/logout', auth, async (req: AuthenticatedRequest, res, next) => {
    try {
      await authService.logout({ sub: req.auth!.sub, username: req.auth!.username });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
