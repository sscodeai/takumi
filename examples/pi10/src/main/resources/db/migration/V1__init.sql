-- 在庫管理システム 初期スキーマ（詳細設計書 §3）
CREATE TABLE products (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  price       NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  stock       INTEGER NOT NULL CHECK (stock >= 0),
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_name VARCHAR(255) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                CHECK (status IN ('DRAFT','CONFIRMED','CANCELED')),
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_status ON orders (status);
CREATE INDEX idx_orders_customer_name ON orders (customer_name);

CREATE TABLE order_items (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity   INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE INDEX idx_order_items_order_id ON order_items (order_id);
CREATE INDEX idx_order_items_product_id ON order_items (product_id);

CREATE TABLE users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(20) NOT NULL CHECK (role IN ('admin','user')),
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- A-07 追加: 入出庫履歴
CREATE TABLE stock_transactions (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id       BIGINT NOT NULL REFERENCES products(id),
  type             VARCHAR(10) NOT NULL CHECK (type IN ('IN','OUT')),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  related_order_id BIGINT REFERENCES orders(id),
  created_by       VARCHAR(255) NOT NULL,
  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_txn_product_id ON stock_transactions (product_id);
CREATE INDEX idx_stock_txn_created_at ON stock_transactions (created_at);
