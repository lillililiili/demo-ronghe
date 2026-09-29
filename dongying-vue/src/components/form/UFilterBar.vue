<template>
  <div class="toolbar u-filter-bar">
    <div class="toolbar-fields u-filter-bar__fields"><slot /></div>
    <div v-if="$slots.actions" class="toolbar-actions u-filter-bar__actions"><slot name="actions" /></div>
    <div v-if="$slots.summary" class="u-filter-bar__summary"><slot name="summary" /></div>
  </div>
</template>

<style scoped>
.u-filter-bar {
  flex: none;
  align-items: flex-end;
  gap: 14px 16px;
  padding: 16px;
  background: var(--surface-gradient);
}
.u-filter-bar__fields {
  flex: 1 1 320px;
  align-items: flex-end;
  gap: 12px 16px;
}
.u-filter-bar__fields :deep(.u-field) {
  flex: 0 1 var(--filter-field-width, 144px);
  width: var(--filter-field-width, 144px);
  min-width: min(100%, var(--filter-field-width, 144px));
  max-width: 100%;
  flex-direction: column;
  align-items: stretch;
  gap: 7px;
}
.u-filter-bar__fields :deep(.u-field > label) {
  color: var(--txt-2);
  font-size: 12px;
  line-height: 1.5;
  white-space: normal;
}
.u-filter-bar__fields :deep(.u-field__control) { width: 100%; }
.u-filter-bar__actions { gap: 10px; flex-wrap: wrap; }
.u-filter-bar__actions :deep(.btn) {
  min-height: 36px;
  height: auto;
  padding: 7px 16px;
  line-height: 1.5;
  white-space: normal;
}
.u-filter-bar__summary {
  flex: 1 0 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 20px;
  padding-top: 12px;
  border-top: 1px solid var(--line-2);
  color: var(--txt-3);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
</style>
