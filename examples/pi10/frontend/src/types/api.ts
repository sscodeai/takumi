export interface UserInfo {
  id: number
  username: string
  role: string
}

export interface LoginRequest {
  username: string
  password: string
}

export interface LoginResponse {
  token: string
  tokenType: string
  expiresIn: number
  user: UserInfo
}

export interface Product {
  id: number
  name: string
  price: number
  stock: number
}

export interface ProductRequest {
  name: string
  price: number
  stock: number
}

export interface StockRequest {
  productId: number
  quantity: number
}

export interface StockResult {
  productId: number
  previousStock: number
  quantity: number
  currentStock: number
}

export interface StockTransaction {
  id: number
  productId: number
  type: 'IN' | 'OUT'
  quantity: number
  relatedOrderId: number | null
  createdBy: string
  createdAt: string
}

export interface OrderItemRequest {
  productId: number
  quantity: number
}

export interface OrderRequest {
  customerName: string
  items: OrderItemRequest[]
}

export interface OrderItem {
  productId: number
  productName: string
  quantity: number
  unitPrice: number
}

export type OrderStatus = 'DRAFT' | 'CONFIRMED' | 'CANCELED'

export interface Order {
  id: number
  customerName: string
  status: OrderStatus
  itemCount: number
  createdAt: string
  items: OrderItem[]
}

export interface AllocatedStock {
  productId: number
  quantity: number
  remainingStock: number
}

export interface ConfirmResponse {
  id: number
  status: OrderStatus
  allocatedStock: AllocatedStock[]
}

export interface StatusResponse {
  id: number
  status: OrderStatus
}

export interface User {
  id: number
  username: string
  role: string
  createdAt: string
}

export interface UserRequest {
  username: string
  password: string
  role: string
}

export interface UserUpdateRequest {
  password?: string
  role?: string
}

export interface PageResponse<T> {
  items: T[]
  total: number
  page: number
  size: number
}

export interface FieldError {
  field: string
  message: string
}

export interface ApiError {
  code: string
  message: string
  timestamp: string
  errors?: FieldError[]
}
