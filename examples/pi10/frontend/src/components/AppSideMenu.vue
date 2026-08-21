<template>
  <nav class="side">
    <router-link to="/products" class="side__link">在庫照会</router-link>
    <template v-if="auth.isAdmin">
      <router-link to="/inventory/receipt" class="side__link">入庫</router-link>
      <router-link to="/inventory/shipment" class="side__link">出庫</router-link>
    </template>
    <router-link to="/orders" class="side__link">受注一覧</router-link>
    <router-link to="/orders/new" class="side__link">新規受注</router-link>
    <template v-if="auth.isAdmin">
      <router-link to="/users" class="side__link">ユーザー管理</router-link>
    </template>
  </nav>
</template>

<script setup lang="ts">
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
</script>

<style scoped>
.side {
  width: 200px;
  background: #fff;
  border-right: 1px solid #e5e7eb;
  padding: 16px 0;
  display: flex;
  flex-direction: column;
}
.side__link {
  padding: 10px 20px;
  color: #374151;
  text-decoration: none;
  font-size: 14px;
}
.side__link:hover { background: #f3f4f6; }
.side__link.router-link-active { background: #eff6ff; color: #1d4ed8; font-weight: 600; }
</style>
