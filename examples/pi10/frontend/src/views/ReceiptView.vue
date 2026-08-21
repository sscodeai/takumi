<template>
  <div>
    <h1 class="page-title">入庫</h1>
    <div class="card">
      <div class="toolbar">
        <select v-model="productId" class="input">
          <option :value="0" disabled>商品を選択</option>
          <option v-for="p in products" :key="p.id" :value="p.id">
            {{ p.name }}（現在在庫 {{ p.stock }}）
          </option>
        </select>
        <input v-model.number="quantity" class="input" type="number" min="1" placeholder="入庫数量" />
        <button class="btn btn--primary" :disabled="loading" @click="submit">実行</button>
      </div>
      <div v-if="message" class="alert alert--error">{{ message }}</div>
      <div v-if="result" class="alert alert--success">
        前在庫 {{ result.previousStock }} → 現在在庫 {{ result.currentStock }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import * as productsApi from '../api/products'
import { receipt } from '../api/inventory'
import { extractError } from '../api/http'
import type { Product, StockResult } from '../types/api'

const products = ref<Product[]>([])
const productId = ref(0)
const quantity = ref<number | null>(null)
const loading = ref(false)
const message = ref('')
const result = ref<StockResult | null>(null)

async function submit() {
  loading.value = true
  message.value = ''
  result.value = null
  try {
    result.value = await receipt({ productId: productId.value, quantity: quantity.value ?? 0 })
  } catch (error) {
    message.value = extractError(error).message
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  const page = await productsApi.fetchProducts(undefined, 0, 100)
  products.value = page.items
})
</script>
