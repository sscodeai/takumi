<template>
  <div>
    <h1 class="page-title">受注詳細</h1>
    <div v-if="order" class="card">
      <div class="detail-head">
        <div>
          <div>受注 ID: {{ order.id }}</div>
          <div>顧客名: {{ order.customerName }}</div>
          <div>状態: {{ statusLabel(order.status) }}</div>
          <div>作成日時: {{ new Date(order.createdAt).toLocaleString() }}</div>
        </div>
        <div class="detail-actions">
          <button v-if="order.status === 'DRAFT'" class="btn btn--primary" @click="confirmVisible = true">確定</button>
          <button v-if="order.status !== 'CANCELED'" class="btn btn--danger" @click="openCancel">キャンセル</button>
          <router-link v-if="order.status === 'DRAFT'" :to="`/orders/${order.id}/edit`" class="btn">編集</router-link>
        </div>
      </div>

      <h3>明細</h3>
      <table class="table">
        <thead>
          <tr><th>商品名</th><th>単価</th><th>数量</th><th>小計</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in order.items" :key="item.productId">
            <td>{{ item.productName }}</td>
            <td>¥{{ item.unitPrice.toLocaleString() }}</td>
            <td>{{ item.quantity }}</td>
            <td>¥{{ (item.unitPrice * item.quantity).toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>

      <div v-if="message" class="alert alert--error">{{ message }}</div>
      <div v-if="successMessage" class="alert alert--success">{{ successMessage }}</div>
    </div>

    <ConfirmDialog
      :show="confirmVisible"
      title="受注確定"
      message="受注を確定し、在庫を引き当てます。よろしいですか？"
      @confirm="doConfirm"
      @cancel="confirmVisible = false"
    />
    <ConfirmDialog
      :show="cancelVisible"
      title="受注キャンセル"
      :message="order?.status === 'CONFIRMED' ? '在庫を戻し入れます。よろしいですか？' : '受注をキャンセルします。よろしいですか？'"
      @confirm="doCancel"
      @cancel="cancelVisible = false"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import * as ordersApi from '../api/orders'
import { extractError } from '../api/http'
import type { Order, OrderStatus } from '../types/api'

const route = useRoute()
const orderId = Number(route.params.id)

const order = ref<Order | null>(null)
const message = ref('')
const successMessage = ref('')
const confirmVisible = ref(false)
const cancelVisible = ref(false)

const statusLabels: Record<OrderStatus, string> = {
  DRAFT: '下書き',
  CONFIRMED: '確定',
  CANCELED: '取消'
}

function statusLabel(status: OrderStatus): string {
  return statusLabels[status]
}

async function load() {
  try {
    order.value = await ordersApi.fetchOrder(orderId)
  } catch (error) {
    message.value = extractError(error).message
  }
}

async function doConfirm() {
  confirmVisible.value = false
  try {
    await ordersApi.confirmOrder(orderId)
    successMessage.value = '確定しました（引き当て済み）'
    await load()
  } catch (error) {
    message.value = extractError(error).message
  }
}

function openCancel() {
  cancelVisible.value = true
}

async function doCancel() {
  cancelVisible.value = false
  try {
    await ordersApi.cancelOrder(orderId)
    successMessage.value = 'キャンセルしました'
    await load()
  } catch (error) {
    message.value = extractError(error).message
  }
}

onMounted(load)
</script>

<style scoped>
.detail-head { display: flex; justify-content: space-between; margin-bottom: 16px; }
.detail-actions { display: flex; gap: 8px; }
.table { width: 100%; border-collapse: collapse; }
.table th, .table td { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: left; font-size: 14px; }
</style>
