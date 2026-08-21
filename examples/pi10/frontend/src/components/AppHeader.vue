<template>
  <header class="header">
    <span class="header__logo">在庫管理システム</span>
    <div class="header__user">
      <span v-if="auth.user" class="header__name">
        {{ auth.user.username }}
        <span class="header__role">（{{ auth.user.role }}）</span>
      </span>
      <button class="btn btn--small" @click="onLogout">ログアウト</button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()

async function onLogout() {
  await auth.logout()
  router.push('/login')
}
</script>

<style scoped>
.header {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  background: #1e3a8a;
  color: #fff;
}
.header__logo { font-weight: 700; font-size: 18px; }
.header__user { display: flex; align-items: center; gap: 12px; }
.header__name { font-size: 14px; }
.header__role { opacity: 0.8; }
</style>
