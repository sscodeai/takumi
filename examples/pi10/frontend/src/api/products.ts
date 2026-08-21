import http from './http'
import type { PageResponse, Product, ProductRequest } from '../types/api'

export async function fetchProducts(name?: string, page = 0, size = 20): Promise<PageResponse<Product>> {
  const { data } = await http.get<PageResponse<Product>>('/products', {
    params: { name: name || undefined, page, size }
  })
  return data
}

export async function fetchProduct(id: number): Promise<Product> {
  const { data } = await http.get<Product>(`/products/${id}`)
  return data
}

export async function createProduct(request: ProductRequest): Promise<Product> {
  const { data } = await http.post<Product>('/products', request)
  return data
}

export async function updateProduct(id: number, request: ProductRequest): Promise<Product> {
  const { data } = await http.put<Product>(`/products/${id}`, request)
  return data
}

export async function deleteProduct(id: number): Promise<void> {
  await http.delete(`/products/${id}`)
}
