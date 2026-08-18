/**
 * 社員ルート（基本設計書 4.2 エンドポイント No.3〜7）
 */

import { Router } from 'express';
import { NotFoundError } from '../domain/errors.ts';
import type { EmployeeService } from '../employees/employeeService.ts';
import { createAuthMiddleware, requireRoles } from '../middleware/authMiddleware.ts';
import type { AuthenticatedRequest } from '../middleware/authMiddleware.ts';
import { validateListQuery } from '../validation/validators.ts';
import type { CreateEmployeeInput, UpdateEmployeeInput } from '../domain/types.ts';
import type { TokenService } from '../auth/token.ts';

export function createEmployeeRouter(service: EmployeeService, tokens: TokenService): Router {
  const router = Router();
  const auth = createAuthMiddleware(tokens);

  // GET /api/employees（全ロール）
  router.get('/', auth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const query = validateListQuery(req.query);
      const page = await service.list(
        {
          keyword: query.keyword,
          role: query.role,
          page: query.page,
          size: query.size,
        },
        req.auth!,
      );
      res.status(200).json(page);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/employees/:id（全ロール）
  router.get('/:id', auth, async (req: AuthenticatedRequest, res, next) => {
    try {
      const id = parseId(req.params.id);
      const employee = await service.getById(id, req.auth!);
      res.status(200).json(employee);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/employees（admin / manager）
  router.post('/', auth, requireRoles('admin', 'manager'), async (req: AuthenticatedRequest, res, next) => {
    try {
      const input = (req.body ?? {}) as CreateEmployeeInput;
      const employee = await service.create(input, req.auth!);
      res.status(201).json(employee);
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/employees/:id（admin / manager）
  router.put('/:id', auth, requireRoles('admin', 'manager'), async (req: AuthenticatedRequest, res, next) => {
    try {
      const id = parseId(req.params.id);
      const input = (req.body ?? {}) as UpdateEmployeeInput;
      const employee = await service.update(id, input, req.auth!);
      res.status(200).json(employee);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/employees/:id（admin）
  router.delete('/:id', auth, requireRoles('admin'), async (req: AuthenticatedRequest, res, next) => {
    try {
      const id = parseId(req.params.id);
      await service.remove(id, req.auth!);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    // 存在しない ID と同じ扱い（404）とする
    throw new NotFoundError('対象のリソースが見つかりません');
  }
  return id;
}
