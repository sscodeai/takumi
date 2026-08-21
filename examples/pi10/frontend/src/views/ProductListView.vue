<template>
  <div>
    <h1 class="page-title">在庫照会</h1>
    <div class="card">
      <div class="toolbar">
        <input v-model="keyword" class="input" placeholder="商品名で検索" @keyup.enter="reload" />
        <button class="btn" @click="reload">検索</button>
        <button v-if="auth.isAdmin" class="btn btn--primary" @click="openCreate">新規商品</button>
      </div>
      <DataTable :columns="columns" :rows="rows" :muted="(row) => (row.stock as number) === 0" @row-click="onRowClick" />
      <div v-if="message" class="alert alert--error">{{ message }}</div>
    </div>

    <div v-if="editing !== null" class="modal-overlay">
      <div class="modal">
        <h3>{{ editing.id ? '商品編集' : '商品登録' }}</h3>
        <FormField v-model="form.name" label="商品名称" required :error="fieldErrors.name" />
        <FormField v-model="form.price" label="単価" type="number" required :error="fieldErrors.price" />
        <FormField v-model="form.stock" label="初期在庫数" type="number" required :error="fieldErrors.stock" />
        <div class="modal__actions">
          <button class="btn" @click="editing = null">キャンセル</button>
          <button class="btn btn--primary" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import DataTable, { type Column } from '../components/DataTable.vue'
import FormField from '../components/FormField.vue'
import { useAuthStore } from '../stores/auth'
import * as productsApi from '../api/products'
import { extractError, fieldError } from '../api/http'
import type { Product } from '../types/api'

const auth = useAuthStore()

const columns: Column[] = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: '名称' },
  { key: 'price', label: '単価', format: (v) => `¥${Number(v).toLocaleString()}` },
  { key: 'stock', label: '在庫数' }
]

const keyword = ref('')
const rows = ref<Record<string, unknown>[]>([])
const message = ref('')
const editing = ref<Product | null>(null)
const form = reactive({ name: '', price: 0, stock: 0 })
const fieldErrors = reactive<{ name?: string; price?: string; stock?: string }>({})

async function reload() {
  try {
    const page = await productsApi.fetchProducts(keyword.value)
    rows.value = page.items.map((p) => ({ ...p }))
  } catch (error) {
    message.value = extractError(error).message
  }
}

function openCreate() {
  editing.value = { id: 0, name: '', price: 0, stock: 0 }
  form.name = ''
  form.price = 0
  form.stock = 0
  clearErrors()
}

function onRowClick(row: Record<string, unknown>) {
  if (!auth.isAdmin) return
  editing.value = row as unknown as Product
  form.name = row.name as string
  form.price = Number(row.price)
  form.stock = Number(row.stock)
  clearErrors()
}

function clearErrors() {
  fieldErrors.name = undefined
  fieldErrors.price = undefined
  fieldErrors.stock = undefined
}

async function save() {
  if (!editing.value) return
  try {
    const request = { name: form.name, price: Number(form.price), stock: Number(form.stock) }
    if (editing.value.id) {
      await productsApi.updateProduct(editing.value.id, request)
    } else {
      await productsApi.createProduct(request)
    }
    editing.value = null
    await reload()
  } catch (error) {
    const apiError = extractError(error)
    if (apiError.code === 'E-400') {
      fieldErrors.name = fieldError(error, 'name')
      fieldErrors.price = fieldError(error, 'price')
      fieldErrors.stock = fieldError(error, 'stock')
    } else {
      message.value = apiError.message
    }
  }
}

onMounted(reload)
</script>

<style scoped>
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal { background: #fff; border-radius: 8px; padding: 24px; width: 400px; }
.modal__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
</style>
