<template>
  <div v-if="show" class="dialog-overlay">
    <div class="dialog">
      <h3 class="dialog__title">{{ title }}</h3>
      <p class="dialog__message">{{ message }}</p>
      <div class="dialog__actions">
        <button class="btn" @click="$emit('cancel')">キャンセル</button>
        <button class="btn btn--danger" @click="$emit('confirm')">実行</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  show: boolean
  title: string
  message: string
}>()

defineEmits<{
  confirm: []
  cancel: []
}>()
</script>

<style scoped>
.dialog-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.dialog { background: #fff; border-radius: 8px; padding: 24px; width: 400px; }
.dialog__title { margin: 0 0 8px; }
.dialog__message { margin: 0 0 20px; font-size: 14px; color: #4b5563; }
.dialog__actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
