<template>
  <div>
    <h1 class="page-title">受注一覧</h1>
    <div class="card">
      <div class="toolbar">
        <input v-model="customerName" class="input" placeholder="顧客名で検索" @keyup.enter="reload" />
        <select v-model="status" class="input">
          <option value="">すべての状態</option>
          <option value="DRAFT">下書き</option>
          <option value="CONFIRMED">確定</option>
          <option value="CANCELED">取消</option>
        </select>
        <button class="btn" @click="reload">検索</button>
        <router-link to="/orders/new" class="btn btn--primary">新規受注</router-link>
      </div>
      <DataTable :columns="columns" :rows="rows" @row-click="onRowClick" />
      <div v-if="message" class="alert alert--error">{{ message }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import DataTable, { type Column } from '../components/DataTable.vue'
import * as ordersApi from '../api/orders'
import { extractError } from '../api/http'
import type { OrderStatus } from '../types/api'

const router = useRouter()

const statusLabels: Record<string, string> = {
  DRAFT: '下書き',
  CONFIRMED: '確定',
  CANCELED: '取消'
}

const columns: Column[] = [
  { key: 'id', label: '受注 ID' },
  { key: 'customerName', label: '顧客名' },
  { key: 'status', label: '状態', format: (v) => statusLabels[String(v)] ?? String(v) },
  { key: 'itemCount', label: '明細数' },
  { key: 'createdAt', label: '作成日時', format: (v) => new Date(String(v)).toLocaleString() }
]

const customerName = ref('')
const status = ref<OrderStatus | ''>('')
const rows = ref<Record<string, unknown>[]>([])
const message = ref('')

async function reload() {
  try {
    const page = await ordersApi.fetchOrders(customerName.value, status.value || undefined)
    rows.value = page.items.map((o) => ({ ...o }))
  } catch (error) {
    message.value = extractError(error).message
  }
}

function onRowClick(row: Record<string, unknown>) {
  router.push(`/orders/${row.id}`)
}

onMounted(reload)
</script>
