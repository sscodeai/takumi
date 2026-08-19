# spring-security-review
Spring Boot アプリのセキュリティレビュー用スキル。

## レビュー観点
- [ ] 認証：パスワードのハッシュ化（BCrypt 等）・ブルートフォース対策・セッション固定攻撃対策
- [ ] 認可：Spring Security のメソッド/URL 認可が正しく設定されているか（@PreAuthorize, securityFilterChain）
- [ ] セッション：HttpOnly/Cookie flags、セッションタイムアウト、CSRF 対策
- [ ] SQL 注入：JPA クエリ / JDBC のパラメータ化、未検証入力の使用箇所
- [ ] 秘密情報：ハードコードされたキー・トークン・DB 接続情報の有無
- 出力：Finding（severity/場所/推奨対応）一覧 + 総評
