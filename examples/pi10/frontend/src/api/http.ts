import axios, { AxiosError } from 'axios'
import type { ApiError } from '../types/api'

const http = axios.create({
  baseURL: '/api',
  timeout: 10000
})

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

http.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiError>) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      if (window.location.pathname !== '/login') {
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

export function extractError(error: unknown): ApiError {
  if (axios.isAxiosError(error) && error.response?.data) {
    return error.response.data as ApiError
  }
  return { code: 'E-500', message: '予期しないエラーが発生しました', timestamp: new Date().toISOString() }
}

export function fieldError(error: unknown, field: string): string | undefined {
  const apiError = extractError(error)
  return apiError.errors?.find((e) => e.field === field)?.message
}

export default http
