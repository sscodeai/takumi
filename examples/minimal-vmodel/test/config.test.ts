/**
 * 設定値読み込み ユニットテスト
 *
 * 実装箇所: src/config.ts
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

describe('loadConfig', () => {
  test('正常系: 環境変数が無い場合の既定値を返す', () => {
    const config = loadConfig({});
    assert.equal(config.port, 3000);
    assert.equal(config.jwtExpiresIn, '30m');
    assert.equal(config.jwtSecret, 'dev-insecure-secret-change-me');
    assert.match(config.databaseUrl, /^postgres:/);
  });

  test('正常系: 環境変数の値で上書きする', () => {
    const config = loadConfig({
      PORT: '8080',
      DATABASE_URL: 'postgres://example',
      JWT_SECRET: 'custom-secret',
      JWT_EXPIRES_IN: '15m',
    });
    assert.equal(config.port, 8080);
    assert.equal(config.databaseUrl, 'postgres://example');
    assert.equal(config.jwtSecret, 'custom-secret');
    assert.equal(config.jwtExpiresIn, '15m');
  });

  test('異常系: 不正な PORT は例外を投げる', () => {
    assert.throws(() => loadConfig({ PORT: '0' }), /Invalid PORT/);
    assert.throws(() => loadConfig({ PORT: '65536' }), /Invalid PORT/);
    assert.throws(() => loadConfig({ PORT: 'abc' }), /Invalid PORT/);
  });

  test('境界値: PORT=1 と PORT=65535 を許容する', () => {
    assert.equal(loadConfig({ PORT: '1' }).port, 1);
    assert.equal(loadConfig({ PORT: '65535' }).port, 65535);
  });
});
