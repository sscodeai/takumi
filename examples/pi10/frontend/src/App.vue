<template>
  <div v-if="isLoginPage" class="app app--login">
    <router-view />
  </div>
  <div v-else class="app">
    <AppHeader />
    <div class="app__body">
      <AppSideMenu />
      <main class="app__content">
        <router-view />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from './components/AppHeader.vue'
import AppSideMenu from './components/AppSideMenu.vue'

const route = useRoute()
const isLoginPage = computed(() => route.path === '/login')
</script>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; color: #1f2937; }
.app__body { display: flex; min-height: calc(100vh - 56px); }
.app__content { flex: 1; padding: 24px; background: #f9fafb; }
.btn { padding: 8px 14px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; color: #1f2937; font-size: 14px; cursor: pointer; }
.btn:hover { background: #f3f4f6; }
.btn--primary { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
.btn--primary:hover { background: #1e40af; }
.btn--danger { background: #dc2626; border-color: #dc2626; color: #fff; }
.btn--danger:hover { background: #b91c1c; }
.btn--small { padding: 4px 10px; font-size: 13px; }
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; }
.page-title { font-size: 20px; margin: 0 0 16px; }
.toolbar { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
.input, select.input { padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; }
.alert { padding: 10px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 12px; }
.alert--error { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
.alert--success { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
</style>
