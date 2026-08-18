/**
 * 認証サービス（基本設計書 第4章 API / 第9章 セキュリティ）
 */

import { AuthenticationError } from '../domain/errors.ts';
import type { AuthResult, Employee, OperationLogEntry } from '../domain/types.ts';
import { verifyPassword } from './password.ts';
import type { TokenService } from './token.ts';
import type { EmployeeRepository } from '../employees/employeeRepository.ts';
import { validateLogin } from '../validation/validators.ts';
import type { OperationLogRepository } from '../logs/operationLog.ts';

export class AuthService {
  constructor(
    private readonly employees: EmployeeRepository,
    private readonly tokens: TokenService,
    private readonly logs: OperationLogRepository,
  ) {}

  async login(username: unknown, password: unknown): Promise<AuthResult> {
    validateLogin(username, password);
    const uname = String(username).trim();

    const employee = await this.employees.findByUsername(uname);
    if (!employee) {
      throw new AuthenticationError('ユーザー名またはパスワードが正しくありません');
    }

    const ok = await verifyPassword(String(password), employee.passwordHash);
    if (!ok) {
      throw new AuthenticationError('ユーザー名またはパスワードが正しくありません');
    }

    const token = this.tokens.sign({ sub: employee.id, username: employee.username, role: employee.role });

    const entry: OperationLogEntry = {
      operatorId: employee.id,
      action: 'LOGIN',
      requestInfo: `username=${employee.username}`,
    };
    await this.logs.record(entry);

    return {
      token,
      employee: {
        id: employee.id,
        employeeNo: employee.employeeNo,
        name: employee.name,
        role: employee.role,
      },
    };
  }

  /** ログアウト（ステートレス JWT のため、クライアント側で破棄。記録のみ行う） */
  async logout(actor: { sub: number; username: string }): Promise<void> {
    const entry: OperationLogEntry = { operatorId: actor.sub, action: 'LOGOUT' };
    await this.logs.record(entry);
  }
}
