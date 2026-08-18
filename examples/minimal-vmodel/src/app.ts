/**
 * Express アプリケーション組み立て（基本設計書 2.3 モジュール構成）
 */

import express from 'express';
import type { EmployeeRepository } from './employees/employeeRepository.ts';
import type { OperationLogRepository } from './logs/operationLog.ts';
import { EmployeeService } from './employees/employeeService.ts';
import { AuthService } from './auth/authService.ts';
import { createTokenService } from './auth/token.ts';
import { createAuthRouter } from './routes/authRoutes.ts';
import { createEmployeeRouter } from './routes/employeeRoutes.ts';
import { createErrorHandler } from './middleware/errorHandler.ts';
import type { ErrorLogger } from './middleware/errorHandler.ts';

export interface AppDependencies {
  employees: EmployeeRepository;
  logs: OperationLogRepository;
  jwtSecret: string;
  jwtExpiresIn: string;
  errorLogger?: ErrorLogger;
}

export function createApp(deps: AppDependencies): express.Express {
  const app = express();
  app.use(express.json());

  const tokens = createTokenService(deps.jwtSecret, deps.jwtExpiresIn);
  const employeeService = new EmployeeService(deps.employees, deps.logs);
  const authService = new AuthService(deps.employees, tokens, deps.logs);

  app.use('/api/auth', createAuthRouter(authService, tokens));
  app.use('/api/employees', createEmployeeRouter(employeeService, tokens));

  // 未定義ルート
  app.use((_req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: '対象のリソースが見つかりません', details: [], traceId: '' },
    });
  });

  // グローバル例外ハンドラ（必ず最後）
  app.use(createErrorHandler(deps.errorLogger));

  return app;
}
