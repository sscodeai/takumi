/**
 * 社員管理サービス（基本設計書 第4章・第6章）
 *
 * 認可（ロールベースアクセス制御）をサービス層で強制する。
 * サーバサイドでの権限チェックを必須とし、クライアント側は UI 制御のみ（6.3）。
 */

import { AuthorizationError, NotFoundError } from '../domain/errors.ts';
import type {
  AuthClaims,
  CreateEmployeeInput,
  Employee,
  EmployeePage,
  EmployeeQuery,
  EmployeeView,
  Role,
  UpdateEmployeeInput,
} from '../domain/types.ts';
import { hashPassword } from '../auth/password.ts';
import { validateCreate, validateUpdate } from '../validation/validators.ts';
import { toView } from './employeeRepository.ts';
import type { EmployeeRepository } from './employeeRepository.ts';
import type { OperationLogRepository } from '../logs/operationLog.ts';

export class EmployeeService {
  constructor(
    private readonly employees: EmployeeRepository,
    private readonly logs: OperationLogRepository,
  ) {}

  private requireEmployee(id: number): Promise<Employee> {
    return this.employees.findById(id).then((e) => {
      if (!e) throw new NotFoundError('対象のリソースが見つかりません');
      return e;
    });
  }

  /**
   * 一覧参照（6.2 権限マトリクス）
   * - admin: 全社員
   * - manager: member のみ
   * - member: 自身のみ
   */
  async list(query: EmployeeQuery, actor: AuthClaims): Promise<EmployeePage> {
    const effectiveQuery: EmployeeQuery = { ...query };

    if (actor.role === 'manager') {
      effectiveQuery.role = 'member';
    } else if (actor.role === 'member') {
      // 自身のみ：ID で絞り込む
      const self = await this.requireEmployee(actor.sub);
      const items: EmployeeView[] = [toView(self)];
      return { total: 1, page: query.page, size: query.size, items };
    }

    const { total, items } = await this.employees.findAll(effectiveQuery);
    return { total, page: query.page, size: query.size, items: items.map(toView) };
  }

  /** 詳細参照（admin 全員 / manager member のみ / member 自身のみ） */
  async getById(id: number, actor: AuthClaims): Promise<EmployeeView> {
    const target = await this.requireEmployee(id);

    if (actor.role === 'admin') {
      return toView(target);
    }
    if (actor.role === 'manager') {
      if (target.role !== 'member') {
        throw new AuthorizationError('この操作を実行する権限がありません');
      }
      return toView(target);
    }
    // member: 自身のみ
    if (target.id !== actor.sub) {
      throw new AuthorizationError('この操作を実行する権限がありません');
    }
    return toView(target);
  }

  /** 社員登録（admin 全ロール / manager member のみ） */
  async create(input: CreateEmployeeInput, actor: AuthClaims): Promise<EmployeeView> {
    validateCreate(input);

    if (actor.role === 'manager' && input.role !== 'member') {
      throw new AuthorizationError('マネージャーは member ロールのみ作成できます');
    }

    const passwordHash = await hashPassword(input.password);
    const created = await this.employees.create({
      employeeNo: input.employeeNo,
      name: input.name.trim(),
      email: input.email.trim(),
      username: input.username.trim(),
      passwordHash,
      role: input.role,
      department: input.department?.trim() || null,
      joinedAt: input.joinedAt || null,
    });

    await this.logs.record({ operatorId: actor.sub, action: 'CREATE', targetId: created.id });
    return toView(created);
  }

  /** 社員更新（admin 全員 / manager member のみ、ロール変更は admin のみ） */
  async update(id: number, input: UpdateEmployeeInput, actor: AuthClaims): Promise<EmployeeView> {
    validateUpdate(input);

    const target = await this.requireEmployee(id);

    // 権限マトリクス（6.2）
    if (actor.role === 'manager') {
      if (target.role !== 'member') {
        throw new AuthorizationError('マネージャーは member のみ更新できます');
      }
      if (input.role !== undefined && input.role !== target.role) {
        throw new AuthorizationError('ロール変更は admin のみ実行できます');
      }
    } else if (actor.role === 'member') {
      throw new AuthorizationError('この操作を実行する権限がありません');
    }

    const passwordHash = input.password !== undefined && input.password !== ''
      ? await hashPassword(input.password)
      : undefined;

    const updated = await this.employees.update(id, {
      employeeNo: input.employeeNo?.trim(),
      name: input.name?.trim(),
      email: input.email?.trim(),
      username: input.username?.trim(),
      passwordHash,
      role: input.role,
      department: input.department?.trim() ?? (input.department === null ? null : undefined),
      joinedAt: input.joinedAt ?? undefined,
    });

    await this.logs.record({ operatorId: actor.sub, action: 'UPDATE', targetId: id });
    return toView(updated);
  }

  /** 社員削除（admin のみ、自身の削除は禁止） */
  async remove(id: number, actor: AuthClaims): Promise<void> {
    if (actor.role !== 'admin') {
      throw new AuthorizationError('この操作を実行する権限がありません');
    }
    if (id === actor.sub) {
      throw new AuthorizationError('自分自身のアカウントは削除できません');
    }
    await this.requireEmployee(id);
    await this.employees.delete(id);
    await this.logs.record({ operatorId: actor.sub, action: 'DELETE', targetId: id });
  }
}
