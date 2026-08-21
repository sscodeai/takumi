<template>
  <div class="login">
    <form class="login__card" @submit.prevent="onSubmit">
      <h2 class="login__title">ログイン</h2>
      <FormField
        v-model="username"
        label="ログイン ID"
        required
        :error="errors.username"
        @update:model-value="errors.username = undefined"
      />
      <FormField
        v-model="password"
        label="パスワード"
        type="password"
        required
        :error="errors.password"
        @update:model-value="errors.password = undefined"
      />
      <div v-if="message" class="alert alert--error">{{ message }}</div>
      <button class="btn btn--primary login__submit" type="submit" :disabled="loading">
        {{ loading ? '送信中...' : 'ログイン' }}
      </button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import FormField from '../components/FormField.vue'
import { useAuthStore } from '../stores/auth'
import { extractError, fieldError } from '../api/http'

const auth = useAuthStore()
const router = useRouter()

const username = ref('')
const password = ref('')
const loading = ref(false)
const message = ref('')
const errors = reactive<{ username?: string; password?: string }>({})

async function onSubmit() {
  loading.value = true
  message.value = ''
  try {
    await auth.login({ username: username.value, password: password.value })
    router.push('/products')
  } catch (error) {
    const apiError = extractError(error)
    if (apiError.code === 'E-400') {
      errors.username = fieldError(error, 'username')
      errors.password = fieldError(error, 'password')
    } else if (apiError.code === 'E-401') {
      message.value = 'ID またはパスワードが違います'
    } else {
      message.value = apiError.message
    }
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f3f4f6; }
.login__card { width: 360px; background: #fff; border-radius: 8px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
.login__title { margin: 0 0 20px; text-align: center; }
.login__submit { width: 100%; margin-top: 8px; }
</style>
