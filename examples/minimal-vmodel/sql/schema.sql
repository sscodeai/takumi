-- 社員管理システム DDL（基本設計書 第5章）
-- PostgreSQL 向け

CREATE TABLE IF NOT EXISTS employees (
  id            BIGSERIAL PRIMARY KEY,
  employee_no   VARCHAR(20)  NOT NULL,
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NOT NULL,
  username      VARCHAR(50)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(20)  NOT NULL CHECK (role IN ('admin', 'manager', 'member')),
  department    VARCHAR(100),
  joined_at     DATE,
  created_at    TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_employee_no ON employees (employee_no);
CREATE UNIQUE INDEX IF NOT EXISTS uk_email       ON employees (email);
CREATE UNIQUE INDEX IF NOT EXISTS uk_username    ON employees (username);
CREATE INDEX IF NOT EXISTS idx_role              ON employees (role);

CREATE TABLE IF NOT EXISTS operation_logs (
  id           BIGSERIAL PRIMARY KEY,
  operator_id  BIGINT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  action       VARCHAR(20) NOT NULL,
  target_id    BIGINT,
  operated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  request_info TEXT
);

CREATE INDEX IF NOT EXISTS idx_operator ON operation_logs (operator_id, operated_at);
