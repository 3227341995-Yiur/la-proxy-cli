<script setup lang="ts">
defineOptions({ name: 'PluginDialog' })

const visible = defineModel({ type: Boolean, default: false })
const props = defineProps({
  title: { type: String, default: '' },
  eyebrow: { type: String, default: '' },
  description: { type: String, default: '' },
  width: { type: String, default: '560px' }
})
const emit = defineEmits(['close'])

function close() {
  visible.value = false
  emit('close')
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :width="props.width"
    append-to-body
    destroy-on-close
    align-center
    class="wr-plugin-dialog"
    :show-close="false"
  >
    <template #header>
      <header class="dlg-head">
        <div class="dlg-heading">
          <span v-if="props.eyebrow" class="dlg-eyebrow">{{ props.eyebrow }}</span>
          <h2>{{ props.title }}</h2>
          <p v-if="props.description">{{ props.description }}</p>
        </div>
        <button type="button" class="dlg-close" aria-label="关闭" @click="close">×</button>
      </header>
    </template>
    <slot />
    <template v-if="$slots.footer" #footer>
      <slot name="footer" />
    </template>
  </el-dialog>
</template>

<style scoped>
.dlg-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px 12px;
}

.dlg-heading {
  min-width: 0;
}

.dlg-eyebrow {
  display: block;
  margin-bottom: 5px;
  color: var(--el-color-primary);
  font-family: var(--wr-mono);
  font-size: 9px;
  font-weight: 650;
  letter-spacing: 0.16em;
}

.dlg-heading h2 {
  margin: 0;
  color: var(--el-text-color-primary);
  font-size: 17px;
  font-weight: 720;
  letter-spacing: -0.02em;
}

.dlg-heading p {
  margin: 5px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 11.5px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.dlg-close {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: none;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--el-text-color-placeholder);
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.15s;
}

.dlg-close:hover {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
}
</style>

<style>
.wr-plugin-dialog.el-dialog {
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 20px;
  background: var(--el-bg-color);
  box-shadow: 0 30px 80px -30px rgba(15, 23, 42, 0.55);
}

.wr-plugin-dialog .el-dialog__header {
  margin: 0;
  padding: 0;
}

.wr-plugin-dialog .el-dialog__body {
  padding: 8px 20px 4px;
}

.wr-plugin-dialog .el-dialog__footer {
  padding: 12px 20px 18px;
}

.wr-plugin-dialog .el-dialog__footer .el-button + .el-button {
  margin-left: 0;
}

.wr-plugin-dialog .el-dialog__footer {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
</style>
