<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { AppDialog } from '@lucky-apps/client-ui'
import hljs from 'highlight.js/lib/core'
import nginxLanguage from 'highlight.js/lib/languages/nginx'
import {
  CopyDocument,
  Document,
  FolderOpened,
  Refresh,
  Search,
  Setting,
  SwitchButton,
  View
} from '@element-plus/icons-vue'
import { service } from './rpc'

hljs.registerLanguage('nginx', nginxLanguage)

defineOptions({ name: 'ProxyCfgPage' })

const loading = ref(true)
const busy = ref(false)
const error = ref('')
const nginxRunning = ref(false)
const settings = reactive({
  nginxPath: '',
  confPath: '',
  syncReload: true,
  autoProxyEnabled: false,
  autoProxyInterval: 1000,
  autoProxyType: 'request'
})
const autoState = reactive({
  enabled: false,
  checking: false,
  lastCheckAt: 0,
  lastChangeAt: 0,
  lastOutput: '',
  error: ''
})
const entries = ref([])
const sourceText = ref('')
const keyword = ref('')
const selected = ref([])
const sourceOpen = ref(false)
const detectOpen = ref(false)
const detectedChanges = ref([])
const settingsOpen = ref(false)
const editOpen = ref(false)
const settingsForm = reactive({
  nginxPath: '',
  confPath: '',
  syncReload: true,
  autoProxyEnabled: false,
  autoProxyInterval: 1000,
  autoProxyType: 'request'
})
const editForm = reactive({ path: '', remote: '', local: '', mode: 'remote' })
const highlightedSource = computed(() => (
  sourceText.value ? hljs.highlight(sourceText.value, { language: 'nginx' }).value : ''
))
const sourceLines = computed(() => sourceText.value.split('\n').length)
const lineNumbers = computed(() => (
  Array.from({ length: sourceLines.value }, (_, index) => String(index + 1)).join('\n')
))
const autoCheckText = computed(() => (
  autoState.lastCheckAt
    ? new Date(autoState.lastCheckAt).toLocaleTimeString('zh-CN', { hour12: false })
    : ''
))
let statusTimer = null

const filteredEntries = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  if (!text) return entries.value
  return entries.value.filter(entry => (
    entry.path.toLowerCase().includes(text)
    || entry.remote.toLowerCase().includes(text)
    || entry.local.toLowerCase().includes(text)
  ))
})
const localCount = computed(() => entries.value.filter(entry => !entry.isRemote).length)
const remoteCount = computed(() => entries.value.filter(entry => entry.isRemote).length)
const selectedEntries = computed(() => entries.value.filter(entry => selected.value.includes(entry.path)))
const allFilteredSelected = computed(() => (
  filteredEntries.value.length > 0
  && filteredEntries.value.every(entry => selected.value.includes(entry.path))
))

function applyDocument(document) {
  if (document.settings) Object.assign(settings, document.settings)
  if (document.autoState) Object.assign(autoState, document.autoState)
  if (Array.isArray(document.entries)) entries.value = document.entries
  if (typeof document.text === 'string') sourceText.value = document.text
  error.value = document.error || ''
}

async function loadBootstrap() {
  loading.value = true
  try {
    const result = await service.bootstrap()
    applyDocument(result)
    nginxRunning.value = Boolean(result.nginxRunning)
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function refreshDocument() {
  try {
    const result = await service.load()
    applyDocument(result)
  } catch (err) {
    error.value = err.message
  }
}

async function refreshStatus() {
  try {
    const previousChange = autoState.lastChangeAt
    const result = await service.status()
    nginxRunning.value = Boolean(result.nginxRunning)
    if (result.autoState) Object.assign(autoState, result.autoState)
    if (autoState.lastChangeAt && autoState.lastChangeAt !== previousChange) {
      await refreshDocument()
    }
  } catch {}
}

async function toggleAuto(enabled) {
  busy.value = true
  try {
    const result = await service.autoProxy(enabled)
    Object.assign(settings, result.settings || {})
    Object.assign(autoState, result.autoState || {})
    if (enabled) ElMessage.success('自动代理已开启')
    else ElMessage.info('自动代理已暂停')
  } catch (err) {
    error.value = err.message
    ElMessage.error(err.message)
    await refreshStatus()
  } finally {
    busy.value = false
  }
}

async function afterSave(result) {
  await refreshDocument()
  await refreshStatus()
  if (result?.reload && !result.reload.ok) {
    ElMessage.warning(`配置已保存，但 nginx reload 失败：${result.reload.output}`)
  }
}

async function applyChanges(changes, reloadAfter = true) {
  if (!changes.length) {
    ElMessage.info('没有需要保存的修改')
    return false
  }
  busy.value = true
  error.value = ''
  try {
    const result = await service.save({ changes, reloadAfter })
    if (!result.ok) {
      const detail = result.output || result.error || '保存失败'
      error.value = result.stage === 'validate'
        ? `nginx -t 校验失败，已回滚原配置：\n${detail}`
        : detail
      ElMessage.error(result.stage === 'validate' ? '配置校验失败，已回滚' : '保存失败')
      await afterSave(result)
      return false
    }
    await afterSave(result)
    ElMessage.success(result.validated ? '配置已保存并校验通过' : '配置已保存（未配置 nginx）')
    return true
  } catch (err) {
    error.value = err.message
    ElMessage.error(err.message)
    return false
  } finally {
    busy.value = false
  }
}

function modeOf(entry) {
  return entry.isRemote ? 'remote' : 'local'
}

function activeUrl(entry) {
  return entry.isRemote ? entry.remote : entry.local
}

function standbyUrl(entry) {
  return entry.isRemote ? entry.local : entry.remote
}

function isSelected(path) {
  return selected.value.includes(path)
}

function toggleSelect(path) {
  selected.value = isSelected(path)
    ? selected.value.filter(item => item !== path)
    : [...selected.value, path]
}

function toggleAll() {
  const paths = filteredEntries.value.map(entry => entry.path)
  if (allFilteredSelected.value) {
    selected.value = selected.value.filter(path => !paths.includes(path))
  } else {
    selected.value = [...new Set([...selected.value, ...paths])]
  }
}

async function switchEntries(target) {
  const list = selectedEntries.value.length ? selectedEntries.value : []
  if (!list.length) {
    ElMessage.info('先勾选要切换的模块')
    return
  }
  const changes = list.map(entry => ({
    path: entry.path,
    mode: target,
    remote: entry.remote,
    local: entry.local
  }))
  await applyChanges(changes, true)
}

async function switchOne(entry, target) {
  await applyChanges([{
    path: entry.path,
    mode: target,
    remote: entry.remote,
    local: entry.local
  }], true)
}

function openEdit(entry) {
  Object.assign(editForm, {
    path: entry.path,
    remote: entry.remote,
    local: entry.local,
    mode: modeOf(entry)
  })
  editOpen.value = true
}

async function saveEdit() {
  const ok = await applyChanges([{
    path: editForm.path,
    mode: editForm.mode,
    remote: editForm.remote,
    local: editForm.local
  }], true)
  if (ok) editOpen.value = false
}

function openSettings() {
  Object.assign(settingsForm, settings)
  settingsOpen.value = true
}

async function pickPath(kind, target) {
  try {
    const result = await service.pickFile(kind)
    if (result?.path) target(result.path)
  } catch (err) {
    ElMessage.error(err.message)
  }
}

async function saveSettings() {
  busy.value = true
  try {
    const result = await service.saveSettings({
      nginxPath: settingsForm.nginxPath,
      confPath: settingsForm.confPath,
      syncReload: settingsForm.syncReload,
      autoProxyEnabled: settingsForm.autoProxyEnabled,
      autoProxyInterval: settingsForm.autoProxyInterval,
      autoProxyType: settingsForm.autoProxyType
    })
    applyDocument(result)
    settingsOpen.value = false
    await refreshStatus()
    ElMessage.success('设置已保存')
  } catch (err) {
    error.value = err.message
    ElMessage.error(err.message)
  } finally {
    busy.value = false
  }
}

async function nginxAction(action) {
  busy.value = true
  try {
    const result = await service.nginx(action)
    if (result.ok) ElMessage.success(result.output || `${action} 成功`)
    else error.value = result.output || `${action} 失败`
    await refreshStatus()
  } catch (err) {
    error.value = err.message
    ElMessage.error(err.message)
  } finally {
    busy.value = false
  }
}

async function copySource() {
  try {
    await navigator.clipboard.writeText(sourceText.value)
    ElMessage.success('源码已复制')
  } catch {
    ElMessage.error('复制失败')
  }
}

async function openSource() {
  try {
    const result = await service.source()
    sourceText.value = result.text || ''
    if (result.error) error.value = result.error
    sourceOpen.value = true
  } catch (err) {
    ElMessage.error(err.message)
  }
}

async function autoDetect() {
  busy.value = true
  try {
    const result = await service.detect()
    const changes = result.changes || []
    if (!changes.length) {
      ElMessage.info('没有可检测的模块')
      return
    }
    detectedChanges.value = changes
    detectOpen.value = true
  } catch (err) {
    ElMessage.error(err.message || String(err))
  } finally {
    busy.value = false
  }
}

async function applyDetected() {
  const changes = detectedChanges.value.map(({ path, mode, remote, local }) => ({ path, mode, remote, local }))
  const ok = await applyChanges(changes, true)
  if (ok) detectOpen.value = false
}

onMounted(async () => {
  await loadBootstrap()
  statusTimer = setInterval(refreshStatus, 3000)
})

onBeforeUnmount(() => clearInterval(statusTimer))
</script>

<template>
  <el-scrollbar class="wr-page proxy-page">
    <div class="wr-page-inner proxy-inner">
      <header class="proxy-header">
        <div class="header-main">
          <div class="wr-eyebrow">Nginx Proxy</div>
          <div class="title-row">
            <h1 class="wr-page-title">代理配置</h1>
            <span class="status-chip" :class="{ online: nginxRunning }">
              <i></i>{{ nginxRunning ? 'Nginx 运行中' : 'Nginx 未运行' }}
            </span>
            <span class="wr-chip">{{ entries.length }} 个模块</span>
            <span class="wr-chip">{{ localCount }} 本地 · {{ remoteCount }} 远程</span>
          </div>
          <p class="wr-page-subtitle">
            {{ settings.confPath || '还没有选择 nginx 配置文件' }}
          </p>
        </div>

        <div class="header-actions">
          <el-dropdown trigger="click" @command="nginxAction">
            <el-button :loading="busy">
              <el-icon><SwitchButton /></el-icon><span>Nginx</span>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="validate">校验配置</el-dropdown-item>
                <el-dropdown-item command="reload">重载</el-dropdown-item>
                <el-dropdown-item command="start" :disabled="nginxRunning">启动</el-dropdown-item>
                <el-dropdown-item command="stop" :disabled="!nginxRunning" divided>停止</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button :disabled="!settings.confPath" @click="openSource">
            <el-icon><Document /></el-icon><span>源码</span>
          </el-button>
          <el-button type="primary" @click="openSettings">
            <el-icon><Setting /></el-icon><span>设置</span>
          </el-button>
        </div>
      </header>

      <el-alert
        v-if="error"
        class="proxy-alert"
        type="error"
        :closable="true"
        show-icon
        :title="error"
        @close="error = ''"
      />

      <div v-if="!settings.confPath" class="proxy-empty">
        <span class="empty-icon"><el-icon :size="30"><FolderOpened /></el-icon></span>
        <h3>还没有打开 nginx 配置</h3>
        <p>在设置里选择 nginx.exe 和要管理的 .conf 文件。</p>
        <el-button type="primary" @click="openSettings">
          <el-icon><Setting /></el-icon><span>选择配置</span>
        </el-button>
      </div>

      <template v-else>
        <div class="proxy-toolbar">
          <div class="toolbar-search">
            <el-icon><Search /></el-icon>
            <input v-model="keyword" placeholder="搜索模块 / 地址" spellcheck="false" />
          </div>
          <div class="toolbar-actions">
            <div class="auto-toggle" :title="autoState.lastOutput || '自动检测本地服务并切换'">
              <span>自动代理</span>
              <el-switch
                :model-value="autoState.enabled"
                size="small"
                :loading="busy"
                :disabled="!settings.confPath"
                @change="toggleAuto"
              />
            </div>
            <el-button size="small" :disabled="!filteredEntries.length" @click="toggleAll">
              {{ allFilteredSelected ? '取消全选' : '全选' }}
            </el-button>
            <el-button size="small" @click="refreshDocument">
              <el-icon><Refresh /></el-icon><span>重新读取</span>
            </el-button>
            <el-button size="small" @click="autoDetect" :loading="busy">
              <el-icon><View /></el-icon><span>检测本地服务</span>
            </el-button>
            <el-button size="small" type="success" plain :disabled="!selected.length || busy" @click="switchEntries('local')">
              切本地
            </el-button>
            <el-button size="small" type="warning" plain :disabled="!selected.length || busy" @click="switchEntries('remote')">
              切远程
            </el-button>
          </div>
        </div>

        <div v-if="autoState.enabled" class="auto-status">
          <span class="auto-dot" :class="{ checking: autoState.checking }"></span>
          <span class="auto-status-text">
            {{ autoState.checking ? '自动检测本地服务…' : autoState.lastOutput || '自动代理运行中' }}
          </span>
          <span v-if="autoCheckText" class="auto-status-time">上次检查 {{ autoCheckText }}</span>
          <span v-if="autoState.error" class="auto-status-error">{{ autoState.error }}</span>
        </div>

        <div class="module-grid">
          <article
            v-for="entry in filteredEntries"
            :key="entry.path"
            class="module-card"
            :class="{ selected: isSelected(entry.path), local: !entry.isRemote }"
            @click="openEdit(entry)"
          >
            <div class="module-card-head">
              <el-checkbox
                :model-value="isSelected(entry.path)"
                class="module-check"
                @click.stop
                @change="toggleSelect(entry.path)"
              />
              <span class="mode-tag" :class="entry.isRemote ? 'remote' : 'local'">
                {{ entry.isRemote ? '远程' : '本地' }}
              </span>
            </div>
            <h3 class="module-name">{{ entry.path }}</h3>
            <div class="module-url active">
              <span>当前</span><code>{{ activeUrl(entry) }}</code>
            </div>
            <div class="module-url standby">
              <span>备选</span><code>{{ standbyUrl(entry) }}</code>
            </div>
            <div class="module-card-actions" @click.stop>
              <el-button
                size="small"
                :type="!entry.isRemote ? 'primary' : 'default'"
                :plain="!entry.isRemote"
                :disabled="busy"
                @click="switchOne(entry, 'local')"
              >本地</el-button>
              <el-button
                size="small"
                :type="entry.isRemote ? 'primary' : 'default'"
                :plain="entry.isRemote"
                :disabled="busy"
                @click="switchOne(entry, 'remote')"
              >远程</el-button>
            </div>
          </article>

          <div v-if="!filteredEntries.length" class="proxy-empty small">
            <span class="empty-icon"><el-icon :size="24"><Search /></el-icon></span>
            <h3>{{ entries.length ? '没有匹配的模块' : '这个配置里没有 location 模块' }}</h3>
            <p v-if="entries.length">换个关键词试试。</p>
          </div>
        </div>
      </template>
    </div>

    <!-- 编辑模块 -->
    <AppDialog
      v-model="editOpen"
      title="编辑代理模块"
      :subtitle="editForm.path"
      icon="Edit"
      width="560px"
      show-footer
    >
      <div class="dialog-body">
        <el-form label-position="top" class="proxy-form">
          <el-form-item label="模块">
            <el-input v-model="editForm.path" disabled />
          </el-form-item>
          <el-form-item label="远程地址">
            <el-input v-model="editForm.remote" placeholder="http://remote-host:port" />
          </el-form-item>
          <el-form-item label="本地地址">
            <el-input v-model="editForm.local" placeholder="http://localhost:port" />
          </el-form-item>
          <el-form-item label="当前指向">
            <el-radio-group v-model="editForm.mode">
              <el-radio-button label="remote">远程</el-radio-button>
              <el-radio-button label="local">本地</el-radio-button>
            </el-radio-group>
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button type="primary" :loading="busy" @click="saveEdit">保存并重载</el-button>
      </template>
    </AppDialog>

    <!-- 设置 -->
    <AppDialog
      v-model="settingsOpen"
      title="Nginx 代理设置"
      subtitle="nginx 路径、配置文件与自动代理"
      icon="Setting"
      width="600px"
      show-footer
    >
      <div class="dialog-body">
        <el-form label-position="top" class="proxy-form">
          <el-form-item label="nginx.exe">
            <div class="path-row">
              <el-input v-model="settingsForm.nginxPath" placeholder="E:\\nginx-1.26.3\\nginx.exe" />
              <el-button @click="pickPath('exe', value => settingsForm.nginxPath = value)">浏览</el-button>
            </div>
          </el-form-item>
          <el-form-item label="配置文件">
            <div class="path-row">
              <el-input v-model="settingsForm.confPath" placeholder="E:\\nginx\\conf\\conf.d\\app.conf" />
              <el-button @click="pickPath('conf', value => settingsForm.confPath = value)">浏览</el-button>
            </div>
          </el-form-item>
          <el-form-item label="保存后自动 reload">
            <el-switch v-model="settingsForm.syncReload" />
            <span class="form-hint">关闭后只写文件和校验，不执行 nginx -s reload</span>
          </el-form-item>
          <el-form-item label="自动代理">
            <div class="auto-settings">
              <el-switch v-model="settingsForm.autoProxyEnabled" />
              <el-input-number
                v-model="settingsForm.autoProxyInterval"
                :min="500"
                :step="500"
                size="small"
                controls-position="right"
              />
              <span class="form-hint">毫秒</span>
              <el-select v-model="settingsForm.autoProxyType" size="small" style="width: 116px">
                <el-option label="HTTP 请求" value="request" />
                <el-option label="端口探测" value="port" />
              </el-select>
            </div>
            <div class="form-hint block">
              开启后按间隔检测各模块本地地址，自动切换并保存；校验失败会回滚。
            </div>
            <div v-if="autoState.lastOutput || autoState.error" class="auto-state-line">
              {{ autoState.lastOutput }}<span v-if="autoState.error"> · {{ autoState.error }}</span>
            </div>
          </el-form-item>
        </el-form>
        <div class="settings-nginx">
          <span>Nginx 进程</span>
          <span class="status-chip" :class="{ online: nginxRunning }">
            <i></i>{{ nginxRunning ? '运行中' : '未运行' }}
          </span>
          <el-button size="small" @click="nginxAction('reload')">重载</el-button>
          <el-button size="small" @click="nginxAction('validate')">校验</el-button>
        </div>
      </div>
      <template #footer>
        <el-button type="primary" :loading="busy" @click="saveSettings">保存设置</el-button>
      </template>
    </AppDialog>

    <!-- 本地服务检测 -->
    <AppDialog
      v-model="detectOpen"
      title="本地服务检测"
      :subtitle="`${detectedChanges.filter(item => item.localAvailable).length} / ${detectedChanges.length} 个本地服务可用`"
      icon="Search"
      width="640px"
      show-footer
    >
      <div class="dialog-body">
        <div class="detect-list">
          <div v-for="item in detectedChanges" :key="item.path" class="detect-row">
            <div class="detect-copy">
              <strong>{{ item.path }}</strong>
              <code>{{ item.localAvailable ? item.local : item.remote }}</code>
            </div>
            <span class="detect-state" :class="{ online: item.localAvailable }">
              <i></i>{{ item.localAvailable ? '本地可用' : '本地不可用' }}
            </span>
          </div>
        </div>
      </div>
      <template #footer>
        <el-button type="primary" :loading="busy" @click="applyDetected">切换并保存</el-button>
      </template>
    </AppDialog>

    <!-- 源码 -->
    <AppDialog
      v-model="sourceOpen"
      title="nginx 配置源码"
      :subtitle="settings.confPath"
      icon="Document"
      width="880px"
    >
      <div class="dialog-body">
        <div class="code-window">
          <div class="code-bar">
            <span class="code-dots"><i></i><i></i><i></i></span>
            <span class="code-name">nginx.conf</span>
            <span class="code-lines">{{ sourceLines }} 行</span>
            <button type="button" class="code-copy" @click="copySource">
              <el-icon><CopyDocument /></el-icon><span>复制</span>
            </button>
          </div>
          <div class="code-body">
            <pre class="line-numbers">{{ lineNumbers }}</pre>
            <pre class="code-block"><code class="hljs language-nginx" v-html="highlightedSource"></code></pre>
          </div>
        </div>
      </div>
    </AppDialog>
  </el-scrollbar>
</template>

<style scoped>
.proxy-page {
  overflow: hidden;
}

.proxy-inner {
  max-width: 1080px;
}

.proxy-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.header-main {
  min-width: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.auto-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 999px;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-secondary);
  font-size: 11px;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* 与宿主 wr-chip 同款胶囊，运行中带成功色 */
.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-weight: 500;
}

.status-chip i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);
}

.status-chip.online {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.status-chip.online i {
  background: var(--el-color-success);
  animation: status-pulse 2s ease-in-out infinite;
}

@keyframes status-pulse {
  50% {
    opacity: 0.35;
  }
}

/* Element Plus 相邻按钮默认 12px 外边距，叠加 gap 后间距过大 */
.proxy-page :deep(.el-button + .el-button) {
  margin-left: 0;
}

.proxy-alert {
  margin-bottom: 14px;
  white-space: pre-wrap;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.stat-tile {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 16px;
  background:
    radial-gradient(circle at 100% 0%, var(--el-color-primary-light-9), transparent 55%),
    var(--el-bg-color);
  transition: transform 0.16s ease, box-shadow 0.16s ease;
}

.stat-tile:hover {
  transform: translateY(-1px);
  box-shadow: 0 14px 30px -24px rgba(15, 23, 42, 0.45);
}

.stat-icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 10px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.stat-icon.local {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.stat-icon.remote {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
}

.stat-icon.online {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.stat-tile strong {
  display: block;
  color: var(--el-text-color-primary);
  font-size: 17px;
  line-height: 1.2;
}

.stat-tile span {
  color: var(--el-text-color-secondary);
  font-size: 10.5px;
}

.proxy-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  padding: 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 14px;
  background: var(--el-fill-color-lighter);
}

.toolbar-search {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 180px;
  max-width: 280px;
  padding: 7px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-placeholder);
}

.toolbar-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--el-text-color-primary);
  font: inherit;
  font-size: 12px;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-left: auto;
}

.auto-status {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: -2px 0 10px;
  padding: 7px 10px;
  border: 1px solid var(--el-color-primary-light-7);
  border-radius: 11px;
  background: var(--el-color-primary-light-9);
  color: var(--el-text-color-secondary);
  font-size: 10.5px;
}

.auto-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--el-color-success);
  box-shadow: 0 0 0 3px var(--el-color-success-light-9);
}

.auto-dot.checking {
  animation: auto-blink 0.8s ease-in-out infinite;
}

.auto-status-text {
  color: var(--el-color-primary);
}

.auto-status-time {
  margin-left: auto;
  color: var(--el-text-color-placeholder);
  font-family: var(--wr-mono);
}

.auto-status-error {
  color: var(--el-color-danger);
}

@keyframes auto-blink {
  50% { opacity: 0.3; }
}

.module-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 10px;
}

.module-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 5px;
  height: 166px;
  padding: 14px;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 18px;
  background:
    radial-gradient(circle at 100% 0%, var(--el-color-primary-light-9), transparent 46%),
    linear-gradient(180deg, var(--el-bg-color), var(--el-fill-color-lighter));
  cursor: pointer;
  transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
}

.module-card:hover {
  transform: translateY(-2px);
  border-color: var(--el-color-primary-light-7);
  box-shadow: 0 14px 30px -22px rgba(15, 23, 42, 0.45);
}

.module-card.selected {
  border-color: var(--el-color-primary-light-5);
}

.module-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.module-check {
  flex: none;
}

.module-name {
  margin: 1px 0 0;
  overflow: hidden;
  color: var(--el-text-color-primary);
  font-size: 15px;
  font-weight: 680;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mode-tag {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning);
  font-size: 9.5px;
  font-weight: 600;
}

.mode-tag.local {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success);
}

.module-url {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 10.5px;
}

.module-url > span {
  flex: none;
  color: var(--el-text-color-placeholder);
}

.module-url code {
  overflow: hidden;
  color: var(--el-text-color-secondary);
  font-family: var(--wr-mono);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.module-url.standby code {
  color: var(--el-text-color-placeholder);
}

.module-card-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  margin-top: auto;
}

.proxy-empty.small {
  grid-column: 1 / -1;
}

.proxy-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 54px 24px;
  border: 1px dashed var(--el-border-color);
  border-radius: 18px;
  background: var(--el-fill-color-lighter);
  text-align: center;
}

.proxy-empty.small {
  padding: 34px 20px;
}

.empty-icon {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  margin-bottom: 10px;
  border-radius: 16px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.proxy-empty h3 {
  margin: 0 0 5px;
  color: var(--el-text-color-primary);
  font-size: 14px;
  font-weight: 650;
}

.proxy-empty p {
  margin: 0 0 14px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.dialog-body {
  padding: 16px 20px 4px;
}

.proxy-form :deep(.el-form-item) {
  margin-bottom: 14px;
}

.proxy-form :deep(.el-form-item:last-child) {
  margin-bottom: 0;
}

.path-row {
  display: flex;
  gap: 6px;
  width: 100%;
}

.path-row .el-input {
  flex: 1;
}

.form-hint {
  margin-left: 8px;
  color: var(--el-text-color-placeholder);
  font-size: 10.5px;
}

.form-hint.block {
  margin: 6px 0 0;
}

.auto-settings {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.auto-settings :deep(.el-input-number) {
  width: 118px;
}

.auto-state-line {
  margin-top: 6px;
  color: var(--el-color-primary);
  font-size: 10.5px;
  overflow-wrap: anywhere;
}

.settings-nginx {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-secondary);
  font-size: 11.5px;
}

.settings-nginx .el-button {
  margin-left: auto;
}

.settings-nginx .el-button + .el-button {
  margin-left: 0;
}

.detect-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 46vh;
  overflow: auto;
  padding: 2px 0;
}

.detect-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 11px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  background: var(--el-fill-color-lighter);
}

.detect-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.detect-copy strong {
  color: var(--el-text-color-primary);
  font-size: 12px;
  font-weight: 650;
}

.detect-copy code {
  overflow: hidden;
  color: var(--el-text-color-secondary);
  font-family: var(--wr-mono);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detect-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  color: var(--el-text-color-placeholder);
  font-size: 10.5px;
}

.detect-state i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);
}

.detect-state.online {
  color: var(--el-color-success);
}

.detect-state.online i {
  background: var(--el-color-success);
  box-shadow: 0 0 0 3px var(--el-color-success-light-9);
}

.code-window {
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 16px;
  background: var(--el-fill-color-lighter);
}

.code-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 12px;
  border-bottom: 1px solid var(--el-border-color-extra-light);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  font-size: 10.5px;
}

.code-dots {
  display: flex;
  gap: 5px;
}

.code-dots i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f87171;
}

.code-dots i:nth-child(2) {
  background: #fbbf24;
}

.code-dots i:nth-child(3) {
  background: #4ade80;
}

.code-name {
  font-family: var(--wr-mono);
  color: var(--el-text-color-primary);
}

.code-lines {
  margin-left: auto;
  color: var(--el-text-color-placeholder);
}

.code-copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 0;
  border-radius: 7px;
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.code-copy:hover {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.code-body {
  display: flex;
  max-height: 56vh;
  overflow: auto;
  background: var(--el-fill-color-lighter);
}

.line-numbers {
  position: sticky;
  left: 0;
  flex: none;
  margin: 0;
  padding: 14px 10px 14px 14px;
  border-right: 1px solid var(--el-border-color-extra-light);
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-placeholder);
  font-family: var(--wr-mono);
  font-size: 11px;
  line-height: 1.6;
  text-align: right;
  user-select: none;
}

.code-block {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 14px 16px 14px 12px;
}

.code-block :deep(.hljs) {
  display: block;
  margin: 0;
  padding: 0;
  background: transparent;
  color: var(--el-text-color-primary);
  font-family: var(--wr-mono);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre;
  overflow: visible;
}

.code-block :deep(.hljs-comment),
.code-block :deep(.hljs-quote) {
  color: var(--el-text-color-placeholder);
  font-style: italic;
}

.code-block :deep(.hljs-keyword),
.code-block :deep(.hljs-selector-tag),
.code-block :deep(.hljs-section),
.code-block :deep(.hljs-name) {
  color: var(--el-color-primary);
  font-weight: 600;
}

.code-block :deep(.hljs-string),
.code-block :deep(.hljs-attr),
.code-block :deep(.hljs-template-variable) {
  color: var(--el-color-success);
}

.code-block :deep(.hljs-number),
.code-block :deep(.hljs-literal) {
  color: var(--el-color-warning);
}

.code-block :deep(.hljs-built_in),
.code-block :deep(.hljs-type) {
  color: var(--el-color-danger);
}

.code-block :deep(.hljs-variable),
.code-block :deep(.hljs-params),
.code-block :deep(.hljs-property) {
  color: var(--el-text-color-primary);
}

.code-block :deep(.hljs-meta),
.code-block :deep(.hljs-symbol) {
  color: var(--el-color-primary);
}

@media (max-width: 860px) {
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .proxy-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .module-grid {
    grid-template-columns: 1fr;
  }
}
</style>
