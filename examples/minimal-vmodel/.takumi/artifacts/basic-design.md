# 社員管理システム 基本設計書

| 項目 | 内容 |
| --- | --- |
| 文書番号 | BD-EMPLOYEE-001 |
| 版数 | 1.0 |
| 作成日 | 2024-01-01 |
| システム名 | 社員管理システム（Employee Management System） |
| 対象フェーズ | 基本設計（Basic Design） |

---

## 1. 概述（概要）

### 1.1 目的
本システムは、組織内の社員情報を一元管理し、認証・認可に基づいて社員情報の参照・登録・更新・削除（CRUD）を行うことを目的とする。

### 1.2 対象範囲
- 社員のログイン認証（ユーザー名＋パスワード）
- 社員情報の CRUD 操作
- ロールベースのアクセス制御（admin / manager / member）
- 入力値の検証およびエラー処理

### 1.3 対象外範囲
- シングルサインオン（SSO）、外部 IdP 連携
- 勤怠管理、給与計算などの周辺機能
- バッチ処理、帳票出力

### 1.4 用語定義

| 用語 | 定義 |
| --- | --- |
| 社員（Employee） | システムに登録される利用者（従業員） |
| ロール（Role） | 利用者に付与される権限種別（admin / manager / member） |
| 認証（Authentication） | 利用者が本人であることを確認する処理 |
| 認可（Authorization） | 認証済み利用者が操作可能な範囲を判定する処理 |

---

## 2. システム構成（アーキテクチャ）

### 2.1 全体構成
3 層クライアント／サーバ構成を採用する。

```
[ブラウザ（Web UI）]
        │  HTTPS
        ▼
[アプリケーションサーバ（API）]
        │  SQL
        ▼
[データベースサーバ（RDBMS）]
```

### 2.2 採用技術（前提）

| 層 | 技術要素 |
| --- | --- |
| 画面 | Web フロントエンド（SPA） |
| API | RESTful API（JSON） |
| 認証 | セッション方式またはトークン方式（JWT） |
| DB | RDBMS（PostgreSQL 等） |
| 実行基盤 | コンテナ（Docker）または仮想サーバ |

### 2.3 モジュール構成

| モジュール | 責務 |
| --- | --- |
| 認証モジュール | ログイン／ログアウト、セッション管理 |
| 社員管理モジュール | 社員情報の CRUD |
| 認可モジュール | ロールに基づくアクセス制御 |
| バリデーションモジュール | 入力値検証 |
| エラーハンドリングモジュール | 例外の捕捉・共通レスポンス生成 |

---

## 3. 画面設計

### 3.1 画面一覧

| 画面 ID | 画面名 | 利用可能ロール | 備考 |
| --- | --- | --- | --- |
| SC-001 | ログイン画面 | 未認証 | ユーザー名・パスワード入力 |
| SC-002 | 社員一覧画面 | admin / manager / member | 検索・一覧表示 |
| SC-003 | 社員詳細画面 | admin / manager / member | 参照専用 |
| SC-004 | 社員登録画面 | admin / manager | 新規作成 |
| SC-005 | 社員編集画面 | admin / manager | 更新 |
| SC-006 | 社員削除確認ダイアログ | admin | 削除 |

### 3.2 画面遷移

```
SC-001（ログイン）
   │ ログイン成功
   ▼
SC-002（社員一覧）
   ├─ 行選択 ───────────▶ SC-003（詳細）
   ├─ [新規登録] ───────▶ SC-004（登録）→ 登録成功 → SC-003
   ├─ [編集] ───────────▶ SC-005（編集）→ 更新成功 → SC-003
   └─ [削除] ───────────▶ SC-006（削除確認）→ 削除成功 → SC-002
```

### 3.3 画面項目定義（主要）

#### SC-001 ログイン画面

| 項目 | 型 | 必須 | 最大長 | 備考 |
| --- | --- | --- | --- | --- |
| ユーザー名 | テキスト | ○ | 50 | 半角英数字 |
| パスワード | パスワード | ○ | 64 | マスク表示 |

#### SC-004 / SC-005 社員登録・編集画面

| 項目 | 型 | 必須 | 最大長 | 備考 |
| --- | --- | --- | --- | --- |
| 社員番号 | テキスト | ○ | 20 | 半角英数字、一意 |
| 氏名 | テキスト | ○ | 100 | |
| メールアドレス | テキスト | ○ | 255 | 形式チェック |
| ユーザー名 | テキスト | ○ | 50 | 一意 |
| ロール | セレクト | ○ | — | admin / manager / member |
| 所属部署 | テキスト | — | 100 | |
| 入社日 | 日付 | — | — | |

---

## 4. API 設計

### 4.1 共通仕様

| 項目 | 内容 |
| --- | --- |
| プロトコル | HTTPS |
| データ形式 | JSON（application/json） |
| 文字コード | UTF-8 |
| エラーレスポンス | 共通エラーフォーマット（8 章参照） |

### 4.2 エンドポイント一覧

| No | メソッド | URI | 概要 | 権限 |
| --- | --- | --- | --- | --- |
| 1 | POST | /api/auth/login | ログイン | 認証不要 |
| 2 | POST | /api/auth/logout | ログアウト | 認証済み |
| 3 | GET | /api/employees | 社員一覧取得 | 全ロール |
| 4 | GET | /api/employees/{id} | 社員詳細取得 | 全ロール |
| 5 | POST | /api/employees | 社員登録 | admin / manager |
| 6 | PUT | /api/employees/{id} | 社員更新 | admin / manager |
| 7 | DELETE | /api/employees/{id} | 社員削除 | admin |

### 4.3 リクエスト／レスポンス定義

#### 4.3.1 POST /api/auth/login

**リクエスト**

```json
{
  "username": "taro.suzuki",
  "password": "Password123!"
}
```

**レスポンス（200）**

```json
{
  "token": "eyJhbGciOi...",
  "employee": {
    "id": 1,
    "employeeNo": "E0001",
    "name": "鈴木 太郎",
    "role": "admin"
  }
}
```

#### 4.3.2 GET /api/employees

**クエリパラメータ**

| パラメータ | 型 | 必須 | 説明 |
| --- | --- | --- | --- |
| keyword | string | — | 氏名・社員番号の部分一致検索 |
| role | string | — | ロール絞り込み |
| page | integer | — | ページ番号（デフォルト 1） |
| size | integer | — | 1 ページ件数（デフォルト 20、最大 100） |

**レスポンス（200）**

```json
{
  "total": 45,
  "page": 1,
  "size": 20,
  "items": [
    {
      "id": 1,
      "employeeNo": "E0001",
      "name": "鈴木 太郎",
      "email": "taro.suzuki@example.com",
      "role": "admin",
      "department": "システム部",
      "joinedAt": "2020-04-01"
    }
  ]
}
```

#### 4.3.3 POST /api/employees

**リクエスト**

```json
{
  "employeeNo": "E0100",
  "name": "佐藤 花子",
  "email": "hanako.sato@example.com",
  "username": "hanako.sato",
  "password": "Password123!",
  "role": "member",
  "department": "営業部",
  "joinedAt": "2024-04-01"
}
```

**レスポンス（201）**

```json
{
  "id": 100,
  "employeeNo": "E0100",
  "name": "佐藤 花子",
  "email": "hanako.sato@example.com",
  "role": "member"
}
```

#### 4.3.4 PUT /api/employees/{id}

リクエストは POST と同項目（パスワードは任意更新）。レスポンスは 200 で更新後オブジェクトを返却する。

#### 4.3.5 DELETE /api/employees/{id}

レスポンスは 204（No Content）。

---

## 5. データベース設計

### 5.1 ER 概要

```
EMPLOYEES（社員）
  1 ── * OPERATION_LOGS（操作ログ）
```

### 5.2 テーブル定義

#### 5.2.1 employees（社員マスタ）

| 論理名 | 物理名 | 型 | 制約 | 説明 |
| --- | --- | --- | --- | --- |
| 社員 ID | id | BIGINT | PK, AUTO INCREMENT | |
| 社員番号 | employee_no | VARCHAR(20) | NOT NULL, UNIQUE | |
| 氏名 | name | VARCHAR(100) | NOT NULL | |
| メールアドレス | email | VARCHAR(255) | NOT NULL, UNIQUE | |
| ユーザー名 | username | VARCHAR(50) | NOT NULL, UNIQUE | ログイン ID |
| パスワードハッシュ | password_hash | VARCHAR(255) | NOT NULL | bcrypt 等でハッシュ化 |
| ロール | role | VARCHAR(20) | NOT NULL | admin / manager / member |
| 所属部署 | department | VARCHAR(100) | | |
| 入社日 | joined_at | DATE | | |
| 作成日時 | created_at | TIMESTAMP | NOT NULL | |
| 更新日時 | updated_at | TIMESTAMP | NOT NULL | |

#### 5.2.2 operation_logs（操作ログ）

| 論理名 | 物理名 | 型 | 制約 | 説明 |
| --- | --- | --- | --- | --- |
| ログ ID | id | BIGINT | PK, AUTO INCREMENT | |
| 操作者 ID | operator_id | BIGINT | FK → employees.id | |
| 操作種別 | action | VARCHAR(20) | NOT NULL | LOGIN / CREATE / UPDATE / DELETE 等 |
| 対象社員 ID | target_id | BIGINT | | |
| 操作日時 | operated_at | TIMESTAMP | NOT NULL | |
| リクエスト情報 | request_info | TEXT | | 必要に応じて |

### 5.3 インデックス

| テーブル | インデックス | カラム |
| --- | --- | --- |
| employees | uk_employee_no | employee_no |
| employees | uk_email | email |
| employees | uk_username | username |
| employees | idx_role | role |
| operation_logs | idx_operator | operator_id, operated_at |

---

## 6. 権限設計（認可）

### 6.1 ロール定義

| ロール | 説明 |
| --- | --- |
| admin | 管理者。全社員に対する全操作が可能 |
| manager | マネージャー。member の作成・更新・参照が可能 |
| member | 一般社員。自身の情報の参照のみ可能 |

### 6.2 権限マトリクス

| 操作 | admin | manager | member |
| --- | --- | --- | --- |
| 社員一覧参照 | ○ | ○（member のみ） | △（自身のみ） |
| 社員詳細参照 | ○ | ○（member のみ） | △（自身のみ） |
| 社員登録 | ○ | ○（member ロールのみ作成可） | × |
| 社員更新 | ○ | ○（member ロールのみ更新可） | × |
| 社員削除 | ○ | × | × |
| ロール変更 | ○ | × | × |
| admin の操作 | ○ | × | × |

凡例：○＝許可、△＝条件付き許可、×＝拒否

### 6.3 認可の実装方針
- 認証済み利用者にロールを紐付け、API 側でリクエストごとにロールを検証する。
- 権限不足時のレスポンスは HTTP 403（Forbidden）を返却する。
- 未認証時のレスポンスは HTTP 401（Unauthorized）を返却する。
- 権限チェックはサーバサイドで必須とし、クライアント側は UI 制御のみに留める。

---

## 7. 入力検証（バリデーション）

### 7.1 共通ルール
- 検証はクライアント側（即時フィードバック）とサーバサイド（最終的な担保）の双方で実施する。
- サーバサイド検証エラーは HTTP 422（Unprocessable Entity）を返却する。

### 7.2 項目別検証ルール

| 項目 | ルール | エラーメッセージ例 |
| --- | --- | --- |
| ユーザー名 | 必須／半角英数字・`-_.`／1〜50 文字 | 「ユーザー名は半角英数字で入力してください」 |
| パスワード | 必須／8〜64 文字／英大文字・英小文字・数字を各 1 種以上含む | 「パスワードは8文字以上で英字・数字を含めてください」 |
| 社員番号 | 必須／半角英数字／1〜20 文字／一意 | 「社員番号は既に使用されています」 |
| 氏名 | 必須／1〜100 文字 | 「氏名を入力してください」 |
| メールアドレス | 必須／メール形式／255 文字以内／一意 | 「メールアドレスの形式が正しくありません」 |
| ロール | 必須／admin・manager・member のいずれか | 「不正なロールが指定されました」 |
| 所属部署 | 任意／100 文字以内 | 「所属部署は100文字以内で入力してください」 |
| 入社日 | 任意／日付形式（YYYY-MM-DD） | 「日付の形式が正しくありません」 |

### 7.3 その他の検証
- リソース存在チェック：対象 ID の社員が存在しない場合は 404 を返却する。
- 論理削除フラグを導入する場合、削除済み社員への操作は 404 として扱う。

---

## 8. エラー処理（例外処理）

### 8.1 共通エラーレスポンスフォーマット

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "入力内容に誤りがあります",
    "details": [
      { "field": "email", "message": "メールアドレスの形式が正しくありません" }
    ],
    "traceId": "3f2a9c1e-..."
  }
}
```

| フィールド | 説明 |
| --- | --- |
| code | エラーコード（機械判定用） |
| message | 利用者向けメッセージ |
| details | 項目単位の詳細（バリデーション時） |
| traceId | 追跡用 ID（ログと紐付け） |

### 8.2 エラーコード一覧

| HTTP ステータス | コード | 発生条件 |
| --- | --- | --- |
| 400 | BAD_REQUEST | リクエスト形式不正（JSON 解析失敗等） |
| 401 | UNAUTHORIZED | 未認証／認証情報失効 |
| 403 | FORBIDDEN | 権限不足 |
| 404 | NOT_FOUND | リソース不存在 |
| 409 | CONFLICT | 一意制約違反（社員番号・メール・ユーザー名重複） |
| 422 | VALIDATION_ERROR | 入力検証エラー |
| 500 | INTERNAL_ERROR | 予期しないシステムエラー |

### 8.3 例外処理方針
- 全例外をグローバルハンドラで捕捉し、共通フォーマットに変換して返却する。
- システム内部情報（スタックトレース等）はレスポンスに含めず、サーバログにのみ出力する。
- 認証・認可・バリデーションは共通例外クラス（`AuthenticationException` / `AuthorizationException` / `ValidationException` 等）を定義し、ハンドラでステータスを決定する。
- `traceId` を発行し、ログとエラーレスポンスを紐付けて調査可能とする。
- 一意制約違反は DB エラーをそのまま返さず、409（CONFLICT）として項目単位で通知する。

### 8.4 シーケンス（エラー発生時）

```
クライアント → 不正リクエスト送信
     │
     ▼
アプリケーション（例外発生）
     │ 共通例外 or 予期しない例外
     ▼
グローバル例外ハンドラ
     ├─ ログ出力（traceId 付与）
     └─ 共通エラーフォーマット生成
     ▼
クライアント（エラー表示）
```

---

## 9. セキュリティ・非機能要件（補足）

| 項目 | 方針 |
| --- | --- |
| パスワード | 平文保存禁止。bcrypt（ソルト付きハッシュ）で保存 |
| 通信 | HTTPS による暗号化 |
| 認証情報 | セッション有効期限を設定（例：30 分） |
| ログ | 認証・CRUD 操作を operation_logs に記録 |
| ロックアウト | 連続ログイン失敗時にアカウントロック（任意） |

---

## 10. 承認記録

| 役割 | 承認者 | 日付 | 承認 |
| --- | --- | --- | --- |
| 基本設計 | （担当者） | 2024-01-01 | ☐ |

---

以上
