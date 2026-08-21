<template>
  <div>
    <h1 class="page-title">{{ isEdit ? '受注編集' : '新規受注' }}</h1>
    <div class="card">
      <FormField v-model="customerName" label="顧客名" required :error="fieldErrors.customerName" />
      <h3>明細</h3>
      <div v-for="(item, index) in items" :key="index" class="order-item">
        <select v-model="item.productId" class="input">
          <option :value="0" disabled>商品を選択</option>
          <option v-for="p in products" :key="p.id" :value="p.id">
            {{ p.name }}（¥{{ p.price.toLocaleString() }}）
          </option>
        </select>
        <input v-model.number="item.quantity" class="input" type="number" min="1" placeholder="数量" />
        <button class="btn" @click="removeItem(index)">削除</button>
      </div>
      <button class="btn" @click="addItem">明細を追加</button>

      <div v-if="message" class="alert alert--error">{{ message }}</div>
      <div class="order-actions">
        <router-link to="/orders" class="btn">戻る</router-link>
        <button class="btn btn--primary" :disabled="loading" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import FormField from '../components/FormField.vue'
import * as productsApi from '../api/products'
import * as ordersApi from '../api/orders'
import { extractError } from '../api/http'
import type { OrderItemRequest, Product } from '../types/api'

const route = useRoute()
const router = useRouter()

const orderId = route.params.id ? Number(route.params.id) : null
const isEdit = computed(() => orderId !== null)

const products = ref<Product[]>([])
const customerName = ref('')
const items = reactive<OrderItemRequest[]>([])
const loading = ref(false)
const message = ref('')
const fieldErrors = reactive<{ customerName?: string }>({})

function addItem() {
  items.push({ productId: 0, quantity: 1 })
}

function removeItem(index: number) {
  items.splice(index, 1)
}

async function load() {
  const page = await productsApi.fetchProducts(undefined, 0, 100)
  products.value = page.items
  if (isEdit.value) {
    const order = await ordersApi.fetchOrder(orderId!)
    customerName.value = order.customerName
    items.splice(0, items.length, ...order.items.map((i) => ({ productId: i.productId, quantity: i.quantity })))
  } else {
    addItem()
  }
}

async function save() {
  loading.value = true
  message.value = ''
  try {
    const request = { customerName: customerName.value, items: [...items] }
    if (isEdit.value) {
      await ordersApi.updateOrder(orderId!, request)
    } else {
      await ordersApi.createOrder(request)
    }
    router.push('/orders')
  } catch (error) {
    message.value = extractError(error).message
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.order-item { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; }
.order-actions { display: flex; justify-content: space-between; margin-top: 16px; }
</style>
