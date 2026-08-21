import http from './http'
import type { PageResponse, User, UserRequest, UserUpdateRequest } from '../types/api'

export async function fetchUsers(page = 0, size = 20): Promise<PageResponse<User>> {
  const { data } = await http.get<PageResponse<User>>('/users', { params: { page, size } })
  return data
}

export async function createUser(request: UserRequest): Promise<User> {
  const { data } = await http.post<User>('/users', request)
  return data
}

export async function updateUser(id: number, request: UserUpdateRequest): Promise<User> {
  const { data } = await http.put<User>(`/users/${id}`, request)
  return data
}

export async function deleteUser(id: number): Promise<void> {
  await http.delete(`/users/${id}`)
}
