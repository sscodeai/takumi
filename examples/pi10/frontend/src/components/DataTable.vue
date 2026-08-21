<template>
  <table class="table">
    <thead>
      <tr>
        <th v-for="col in columns" :key="col.key">{{ col.label }}</th>
        <th v-if="$slots.actions">操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="row.id" @click="$emit('row-click', row)">
        <td v-for="col in columns" :key="col.key" :class="{ 'is-muted': muted && muted(row) }">
          {{ format(row, col) }}
        </td>
        <td v-if="$slots.actions" @click.stop>
          <slot name="actions" :row="row" />
        </td>
      </tr>
      <tr v-if="rows.length === 0">
        <td :colspan="columns.length + ($slots.actions ? 1 : 0)" class="table__empty">データがありません</td>
      </tr>
    </tbody>
  </table>
</template>

<script setup lang="ts">
export interface Column {
  key: string
  label: string
  format?: (value: unknown, row: Record<string, unknown>) => string
}

defineProps<{
  columns: Column[]
  rows: Record<string, unknown>[]
  muted?: (row: Record<string, unknown>) => boolean
}>()

defineEmits<{
  'row-click': [row: Record<string, unknown>]
}>()

function format(row: Record<string, unknown>, col: Column): string {
  const value = row[col.key]
  if (col.format) return col.format(value, row)
  return value == null ? '' : String(value)
}
</script>

<style scoped>
.table { width: 100%; border-collapse: collapse; background: #fff; }
.table th, .table td { padding: 10px 12px; border-bottom: 1px solid #e5e7eb; text-align: left; font-size: 14px; }
.table th { background: #f3f4f6; font-weight: 600; }
.table tr { cursor: pointer; }
.table tr:hover td { background: #f9fafb; }
.table__empty { text-align: center; color: #9ca3af; cursor: default; }
.is-muted { color: #9ca3af; }
</style>
