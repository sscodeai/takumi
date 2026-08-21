import http from './http'
import type { PageResponse, StockRequest, StockResult, StockTransaction } from '../types/api'

export async function receipt(request: StockRequest): Promise<StockResult> {
  const { data } = await http.post<StockResult>('/inventory/receipt', request)
  return data
}

export async function shipment(request: StockRequest): Promise<StockResult> {
  const { data } = await http.post<StockResult>('/inventory/shipment', request)
  return data
}

export async function fetchTransactions(productId?: number, page = 0, size = 20): Promise<PageResponse<StockTransaction>> {
  const { data } = await http.get<PageResponse<StockTransaction>>('/inventory/transactions', {
    params: { productId: productId || undefined, page, size }
  })
  return data
}
