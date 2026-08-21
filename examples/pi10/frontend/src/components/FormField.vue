<template>
  <label class="field">
    <span class="field__label">{{ label }}<span v-if="required" class="field__required">*</span></span>
    <input
      class="field__input"
      :class="{ 'field__input--error': error }"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <span v-if="error" class="field__error">{{ error }}</span>
  </label>
</template>

<script setup lang="ts">
defineProps<{
  label: string
  modelValue: string | number
  type?: string
  placeholder?: string
  required?: boolean
  error?: string
}>()

defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<style scoped>
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.field__label { font-size: 13px; font-weight: 600; color: #374151; }
.field__required { color: #dc2626; margin-left: 2px; }
.field__input { padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; }
.field__input--error { border-color: #dc2626; }
.field__error { font-size: 12px; color: #dc2626; }
</style>
