import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as authApi from '../api/auth'
import type { LoginRequest, UserInfo } from '../types/api'

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('token'))
  const user = ref<UserInfo | null>(readStoredUser())

  const isAuthenticated = computed(() => !!token.value)
  const role = computed(() => user.value?.role ?? null)
  const isAdmin = computed(() => user.value?.role === 'admin')

  function readStoredUser(): UserInfo | null {
    const raw = localStorage.getItem('user')
    if (!raw) return null
    try {
      return JSON.parse(raw) as UserInfo
    } catch {
      return null
    }
  }

  async function login(request: LoginRequest): Promise<void> {
    const response = await authApi.login(request)
    token.value = response.token
    user.value = response.user
    localStorage.setItem('token', response.token)
    localStorage.setItem('user', JSON.stringify(response.user))
  }

  async function logout(): Promise<void> {
    try {
      await authApi.logout()
    } finally {
      token.value = null
      user.value = null
      localStorage.removeItem('token')
      localStorage.removeItem('user')
    }
  }

  return { token, user, isAuthenticated, role, isAdmin, login, logout }
})
