import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
    { path: '/products', name: 'products', component: () => import('../views/ProductListView.vue') },
    { path: '/inventory/receipt', name: 'receipt', component: () => import('../views/ReceiptView.vue'), meta: { roles: ['admin'] } },
    { path: '/inventory/shipment', name: 'shipment', component: () => import('../views/ShipmentView.vue'), meta: { roles: ['admin'] } },
    { path: '/orders', name: 'orders', component: () => import('../views/OrderListView.vue') },
    { path: '/orders/new', name: 'order-new', component: () => import('../views/OrderFormView.vue') },
    { path: '/orders/:id', name: 'order-detail', component: () => import('../views/OrderDetailView.vue') },
    { path: '/orders/:id/edit', name: 'order-edit', component: () => import('../views/OrderFormView.vue') },
    { path: '/users', name: 'users', component: () => import('../views/UserListView.vue'), meta: { roles: ['admin'] } },
    { path: '/', redirect: '/products' }
  ]
})

router.beforeEach((to) => {
  const auth = useAuthStore()
  if (!to.meta.public && !auth.isAuthenticated) {
    return { name: 'login' }
  }
  if (to.meta.roles && (!auth.role || !to.meta.roles.includes(auth.role))) {
    return { name: 'products' }
  }
  if (to.name === 'login' && auth.isAuthenticated) {
    return { name: 'products' }
  }
  return true
})

export default router
