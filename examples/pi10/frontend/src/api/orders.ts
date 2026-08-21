import http from './http'
import type { ConfirmResponse, Order, OrderRequest, OrderStatus, PageResponse, StatusResponse } from '../types/api'

export async function fetchOrders(
  customerName?: string,
  status?: OrderStatus,
  page = 0,
  size = 20
): Promise<PageResponse<Order>> {
  const { data } = await http.get<PageResponse<Order>>('/orders', {
    params: { customerName: customerName || undefined, status: status || undefined, page, size }
  })
  return data
}

export async function createOrder(request: OrderRequest): Promise<Order> {
  const { data } = await http.post<Order>('/orders', request)
  return data
}

export async function fetchOrder(id: number): Promise<Order> {
  const { data } = await http.get<Order>(`/orders/${id}`)
  return data
}

export async function updateOrder(id: number, request: OrderRequest): Promise<Order> {
  const { data } = await http.put<Order>(`/orders/${id}`, request)
  return data
}

export async function confirmOrder(id: number): Promise<ConfirmResponse> {
  const { data } = await http.post<ConfirmResponse>(`/orders/${id}/confirm`)
  return data
}

export async function cancelOrder(id: number): Promise<StatusResponse> {
  const { data } = await http.post<StatusResponse>(`/orders/${id}/cancel`)
  return data
}
