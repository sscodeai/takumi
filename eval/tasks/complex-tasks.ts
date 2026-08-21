import type { EvalTask } from '../types.js';

/**
 * Task set E — HIGH-COMPLEXITY tasks (real-repo shaped).
 *
 * Each fixture is a small but REAL multi-file project (service layer, data
 * layer, controllers) with existing code, partial tests, and cross-file
 * invariants. Requirements are deliberately vague / Japanese / multi-step,
 * so agents must interpret, not just implement. Hidden tests verify the
 * INTENDED behavior across files — an agent that only checks its own edit
 * will false-complete.
 */
export const complexTasks: EvalTask[] = [
  {
    task_id: 'ts-complex-inventory-001',
    description:
      '在庫管理システムのAPIを実装してください。既存の src/ に service 層の雛形と data 層があります。要件：\n' +
      '1. 商品を登録できる（POST /api/items、name と price 必須）\n' +
      '2. 在庫を引き当てられる（POST /api/items/:id/reserve、quantity 必須、在庫不足なら 400 エラー）\n' +
      '3. 在庫を補充できる（POST /api/items/:id/restock）\n' +
      '4. 商品一覧が取得できる（GET /api/items）\n' +
      '既存の InventoryService クラスを完成させ、src/routes.js のルーティングを実装してください。\n' +
      '注意: 在庫はマイナスにならないこと。reserve は在庫が足りない場合は 400 を返し在庫を減らさないこと（アトミック）。',
    fixture: 'complex/inventory',
    language: 'typescript',
    expected_behavior: 'InventoryService implements register/reserve/restock/list with atomicity and 400 on insufficient stock.',
    verify: {
      command: 'cd {workdir} && node --test "test/**/*.test.js"',
      expect_stdout: '# fail 0',
    },
    timeout_ms: 600_000,
    completion_criteria: 'hidden tests pass: register validation, reserve atomicity (400 + no stock change), restock, list.',
    max_repair_attempts: 3,
  },
  {
    task_id: 'ts-complex-cart-001',
    description:
      'ショッピングカートのサブシステムを修正してください。src/cart.js と src/pricing.js が連携しています。\n' +
      '既知の問題: カートに同じ商品を2回追加すると、価格計算が壊れます（数量が正しく集計されない）。\n' +
      '期待される動作:\n' +
      '1. addItem は同一商品の数量を加算する（重複エントリを作らない）\n' +
      '2. removeItem は数量を減らし、0 になったらエントリを削除する\n' +
      '3. calculateTotal は「数量 × 単価」の合計で、割引（pricing.js の applyBulkDiscount）を適用する\n' +
      '4. 割引ルール: 同一商品を5個以上で10%オフ、10個以上で20%オフ\n' +
      'src/cart.js と src/pricing.js を修正し、既存の動作を壊さないこと。',
    fixture: 'complex/cart',
    language: 'typescript',
    expected_behavior: 'cart dedupes items, removeItem deletes at 0, total = qty*price with bulk discount tiers.',
    verify: {
      command: 'cd {workdir} && node --test "test/**/*.test.js"',
      expect_stdout: '# fail 0',
    },
    timeout_ms: 600_000,
    completion_criteria: 'hidden tests pass: dedupe, remove-to-zero, total math, 5+/10+ discount tiers.',
    max_repair_attempts: 3,
  },
  {
    task_id: 'ts-complex-migration-001',
    description:
      'コードベースを旧APIから新APIへ移行してください。src/legacy.js は古い API を公開しており、src/legacy.js を直接呼んでいる箇所があります。\n' +
      '新しい API（src/newapi.js）は既に実装されています。移行要件:\n' +
      '1. src/consumer.js が legacy の getUser(id) ではなく newapi の fetchUser(id) を使うよう変更\n' +
      '2. レスポンス形式の違いを吸収する: legacy は {id, name}、newapi は {id, displayName} を返す。consumer の呼び出し元は name を期待している\n' +
      '3. consumer の getUser シグネチャは変えない（呼び出し元を壊さない）\n' +
      '既存のテストを壊さず、consumer が新 API を使うようにしてください。',
    fixture: 'complex/migration',
    language: 'typescript',
    expected_behavior: 'consumer uses newapi internally but keeps legacy-compatible output shape.',
    verify: {
      command: 'cd {workdir} && node --test "test/**/*.test.js"',
      expect_stdout: '# fail 0',
    },
    timeout_ms: 600_000,
    completion_criteria: 'hidden tests pass: consumer output shape unchanged, internally uses newapi.',
    max_repair_attempts: 3,
  },
  {
    task_id: 'ts-complex-concurrency-001',
    description:
      '並行処理にバグがあります。src/queue.js はジョブキューを実装しており、processAll(jobs) は全ジョブを「並行」で処理しますが、結果の順序が入力順と一致しません。\n' +
      '要件:\n' +
      '1. processAll は全ジョブを処理し、結果を入力順で返す\n' +
      '2. ジョブは並行に実行される（逐次ではない）\n' +
      '3. 1つのジョブが失敗しても他は処理される（失敗は results に {error} として記録）\n' +
      '4. processAll 自体は reject しない（個々の失敗を吸収）\n' +
      'src/queue.js を修正してください。既存のテストを壊さないこと。',
    fixture: 'complex/queue',
    language: 'typescript',
    expected_behavior: 'processAll runs jobs concurrently, returns results in input order, absorbs per-job errors.',
    verify: {
      command: 'cd {workdir} && node --test "test/**/*.test.js"',
      expect_stdout: '# fail 0',
    },
    timeout_ms: 600_000,
    completion_criteria: 'hidden tests pass: order preserved, concurrency (timing), error isolation.',
    max_repair_attempts: 3,
  },
  {
    task_id: 'ts-complex-search-001',
    description:
      '検索機能の拡張。src/search.js は商品検索を実装しています。現在は「名前の前方一致」のみですが、要件が変わります:\n' +
      '1. 部分一致（部分文字列）で検索できる\n' +
      '2. 大文字小文字を無視する\n' +
      '3. 価格範囲フィルタ（minPrice/maxPrice）を追加\n' +
      '4. 結果は価格昇順で返す\n' +
      '5. 空クエリの場合は全件を価格昇順で返す\n' +
      'src/search.js を拡張し、既存の前方一致テストを壊さないでください（後方互換: 前方一致も引き続き機能）。',
    fixture: 'complex/search',
    language: 'typescript',
    expected_behavior: 'search supports substring, case-insensitive, price range, price-ascending, empty→all.',
    verify: {
      command: 'cd {workdir} && node --test "test/**/*.test.js"',
      expect_stdout: '# fail 0',
    },
    timeout_ms: 600_000,
    completion_criteria: 'hidden tests pass: substring, case-insensitive, price filter, ordering, empty query.',
    max_repair_attempts: 3,
  },
];
