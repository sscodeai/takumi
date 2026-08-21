<template>
  <div>
    <h1 class="page-title">ユーザー管理</h1>
    <div class="card">
      <div class="toolbar">
        <button class="btn btn--primary" @click="openCreate">新規ユーザー</button>
      </div>
      <DataTable :columns="columns" :rows="rows">
        <template #actions="{ row }">
          <button class="btn btn--small" @click="openEdit(row)">編集</button>
          <button class="btn btn--small btn--danger" @click="askDelete(row)">削除</button>
        </template>
      </DataTable>
      <div v-if="message" class="alert alert--error">{{ message }}</div>
    </div>

    <div v-if="editing" class="modal-overlay">
      <div class="modal">
        <h3>{{ editingId ? 'ユーザー編集' : 'ユーザー登録' }}</h3>
        <FormField v-if="!editingId" v-model="form.username" label="ログイン ID" required :error="fieldErrors.username" />
        <FormField v-model="form.password" label="パスワード（編集時は変更する場合のみ）" type="password" :required="!editingId" :error="fieldErrors.password" />
        <label class="field">
          <span class="field__label">ロール</span>
          <select v-model="form.role" class="input">
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <div class="modal__actions">
          <button class="btn" @click="editing = false">キャンセル</button>
          <button class="btn btn--primary" @click="save">保存</button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :show="deleteTarget !== null"
      title="ユーザー削除"
      :message="deleteTarget ? `ユーザー ${deleteTarget.username} を削除します。よろしいですか？` : ''"
      @confirm="doDelete"
      @cancel="deleteTarget = null"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import DataTable, { type Column } from '../components/DataTable.vue'
import FormField from '../components/FormField.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import * as usersApi from '../api/users'
import { extractError, fieldError } from '../api/http'
import type { User } from '../types/api'

const columns: Column[] = [
  { key: 'id', label: 'ID' },
  { key: 'username', label: 'ログイン ID' },
  { key: 'role', label: 'ロール' },
  { key: 'createdAt', label: '作成日時', format: (v) => new Date(String(v)).toLocaleString() }
]

const rows = ref<Record<string, unknown>[]>([])
const message = ref('')
const editing = ref(false)
const editingId = ref<number | null>(null)
const form = reactive({ username: '', password: '', role: 'user' })
const fieldErrors = reactive<{ username?: string; password?: string }>({})
const deleteTarget = ref<User | null>(null)

async function reload() {
  try {
    const page = await usersApi.fetchUsers()
    rows.value = page.items.map((u) => ({ ...u }))
  } catch (error) {
    message.value = extractError(error).message
  }
}

function openCreate() {
  editingId.value = null
  form.username = ''
  form.password = ''
  form.role = 'user'
  clearErrors()
  editing.value = true
}

function openEdit(row: Record<string, unknown>) {
  editingId.value = Number(row.id)
  form.username = String(row.username)
  form.password = ''
  form.role = String(row.role)
  clearErrors()
  editing.value = true
}

function clearErrors() {
  fieldErrors.username = undefined
  fieldErrors.password = undefined
}

async function save() {
  try {
    if (editingId.value) {
      await usersApi.updateUser(editingId.value, {
        password: form.password || undefined,
        role: form.role
      })
    } else {
      await usersApi.createUser({ username: form.username, password: form.password, role: form.role })
    }
    editing.value = false
    await reload()
  } catch (error) {
    const apiError = extractError(error)
    if (apiError.code === 'E-400') {
      fieldErrors.username = fieldError(error, 'username')
      fieldErrors.password = fieldError(error, 'password')
    } else {
      message.value = apiError.message
    }
  }
}

function askDelete(row: Record<string, unknown>) {
  deleteTarget.value = row as unknown as User
}

async function doDelete() {
  const target = deleteTarget.value
  deleteTarget.value = null
  if (!target) return
  try {
    await usersApi.deleteUser(target.id)
    await reload()
  } catch (error) {
    message.value = extractError(error).message
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
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.field__label { font-size: 13px; font-weight: 600; color: #374151; }
</style>
