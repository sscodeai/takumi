import http from './http'
import type { LoginRequest, LoginResponse } from '../types/api'

export async function login(request: LoginRequest): Promise<LoginResponse> {
  const { data } = await http.post<LoginResponse>('/login', request)
  return data
}

export async function logout(): Promise<void> {
  await http.post('/logout')
}
