/**
 * la-proxy-cli Node half.
 *
 * 独立的 nginx 反向代理配置服务：读写 nginx conf、nginx -t 校验、reload，
 * 不经过周报宿主，也不修改宿主代码。
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { lookup } from 'node:dns/promises'
import { promisify } from 'node:util'

export const name = 'la-proxy-cli'

const execFileAsync = promisify(execFile)
const PORT = Number(process.env.WR_PROXY_CFG_PORT || 38472)
const TOKEN = 'wr-proxy-cfg-local'
const MAX_BODY = 4 * 1024 * 1024

// ============================================================
// 配置解析（与 node_cfg-cli 的正则语义一致）
// ============================================================
const LOCATION_RE = /location\s+\^~\/(?!node_modules)([\p{L}\p{N}_-]+)\/\s*\{([^}]+)\}/gsu
const ACTIVE_RE = /^[ \t]*proxy_pass\s+([^;]+);/m
const COMMENT_RE = /^[ \t]*#+[ \t]*proxy_pass\s+([^;]+);/m

interface NginxEntry {
  path: string
  remote: string
  local: string
  isRemote: boolean
  start: number
  end: number
}

interface AppSettings {
  nginxPath: string
  confPath: string
  syncReload: boolean
  autoProxyEnabled: boolean
  autoProxyInterval: number
  autoProxyType: 'request' | 'port'
}

export class NginxConfigDocument {
  private _text: string
  private _entries: NginxEntry[]

  constructor(text: string, entries: NginxEntry[]) {
    this._text = text
    this._entries = entries
  }

  static parse(text: string): NginxConfigDocument {
    const entries: NginxEntry[] = []
    LOCATION_RE.lastIndex = 0
    let match
    while ((match = LOCATION_RE.exec(text))) {
      const path = match[1]
      const block = match[2]
      const activeMatch = ACTIVE_RE.exec(block)
      const commentMatch = COMMENT_RE.exec(block)
      const active = activeMatch ? activeMatch[1].trim() : ''
      const comment = commentMatch ? commentMatch[1].trim() : ''
      const localActive = active.includes('localhost')
      const remote = localActive ? comment : active
      const local = localActive ? active : comment
      const isRemote = Boolean(activeMatch) && !localActive
      entries.push({
        path,
        remote,
        local,
        isRemote,
        start: match.index,
        end: match.index + match[0].length
      })
    }
    return new NginxConfigDocument(text, entries)
  }

  get entries(): NginxEntry[] {
    return [...this._entries]
  }

  text(): string {
    return this._text
  }

  find(path: string): NginxEntry | null {
    return this._entries.find(entry => entry.path === path) || null
  }

  setEntry(path: string, mode: string, remote?: string | null, local?: string | null): boolean {
    if (mode !== 'remote' && mode !== 'local') throw new Error(`mode 必须为 remote 或 local: ${mode}`)
    const index = this._entries.findIndex(entry => entry.path === path)
    if (index === -1) return false
    const entry = this._entries[index]
    const nextRemote = remote === undefined || remote === null ? entry.remote : String(remote).trim()
    const nextLocal = local === undefined || local === null ? entry.local : String(local).trim()
    const active = mode === 'remote' ? nextRemote : nextLocal
    const standby = mode === 'remote' ? nextLocal : nextRemote
    const block = `location ^~/${path}/ {\n    proxy_pass ${active};\n    # proxy_pass ${standby};\n  }`
    this._text = this._text.slice(0, entry.start) + block + this._text.slice(entry.end)
    const delta = block.length - (entry.end - entry.start)
    entry.remote = nextRemote
    entry.local = nextLocal
    entry.isRemote = mode === 'remote'
    entry.end = entry.start + block.length
    for (const later of this._entries.slice(index + 1)) {
      later.start += delta
      later.end += delta
    }
    return true
  }
}

// ============================================================
// 设置：读取旧 proxy_cfg-cli config.ini，写入插件自己的 config.json
// ============================================================
function appDataDir() {
  return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
}

export function settingsPath() {
  return process.env.WR_PROXY_CFG_DATA || join(appDataDir(), 'week-report-proxy-cfg', 'config.json')
}

function legacyIniPath() {
  return join(appDataDir(), 'proxy_cfg-cli', 'config.ini')
}

function parseIni(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {}
  let section = ''
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const sectionMatch = line.match(/^\[(.+)]$/)
    if (sectionMatch) {
      section = sectionMatch[1].trim()
      sections[section] ||= {}
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1 || !section) continue
    sections[section][line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return sections
}

function boolValue(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  return String(value).trim().toLowerCase() === 'true'
}

function readLegacySettings(): Partial<AppSettings> {
  try {
    const ini = parseIni(readFileSync(legacyIniPath(), 'utf8'))
    return {
      nginxPath: ini.state?.nginx_path || '',
      confPath: ini.state?.last_file || '',
      syncReload: boolValue(ini.app?.sync_nginx_enabled, true),
      autoProxyInterval: Number(ini.app?.auto_proxy_interval_msec) || 1000,
      autoProxyType: ini.app?.auto_proxy_type === 'port' ? 'port' : 'request'
    }
  } catch {
    return {}
  }
}

export function loadSettings(): AppSettings {
  let saved: Partial<AppSettings> = {}
  try {
    saved = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  } catch {}
  const legacy = readLegacySettings()
  return {
    nginxPath: String(saved.nginxPath || legacy.nginxPath || ''),
    confPath: String(saved.confPath || legacy.confPath || ''),
    syncReload: saved.syncReload === undefined ? (legacy.syncReload ?? true) : Boolean(saved.syncReload),
    // 旧配置里的自动代理默认不直接接管，避免打开页面就改真实 nginx 配置
    autoProxyEnabled: Boolean(saved.autoProxyEnabled),
    autoProxyInterval: Math.max(500, Number(saved.autoProxyInterval || legacy.autoProxyInterval || 1000)),
    autoProxyType: saved.autoProxyType === 'port' || legacy.autoProxyType === 'port' ? 'port' : 'request'
  }
}

function persistSettings(patch: Partial<AppSettings> = {}): AppSettings {
  const current = loadSettings()
  const next: AppSettings = {
    nginxPath: patch.nginxPath === undefined ? current.nginxPath : String(patch.nginxPath || '').trim(),
    confPath: patch.confPath === undefined ? current.confPath : String(patch.confPath || '').trim(),
    syncReload: patch.syncReload === undefined ? current.syncReload : Boolean(patch.syncReload),
    autoProxyEnabled: patch.autoProxyEnabled === undefined ? current.autoProxyEnabled : Boolean(patch.autoProxyEnabled),
    autoProxyInterval: patch.autoProxyInterval === undefined
      ? current.autoProxyInterval
      : Math.max(500, Number(patch.autoProxyInterval) || 1000),
    autoProxyType: patch.autoProxyType === 'port' ? 'port' : 'request'
  }
  const file = settingsPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

// ============================================================
// nginx 命令
// ============================================================
function decodeOutput(buffer) {
  if (!buffer) return ''
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  if (!utf8.includes('�')) return utf8
  try {
    return new TextDecoder('gbk').decode(bytes)
  } catch {
    return utf8
  }
}

function normalizePath(value: string) {
  let text = String(value || '')
  if (text.startsWith('\\\\?\\')) text = text.slice(4)
  return text.replace(/\//g, '\\').toLowerCase()
}

async function ensureNginxPid(settings: AppSettings): Promise<{ ok: boolean; output?: string }> {
  if (process.platform !== 'win32' || !settings.nginxPath) return { ok: true }
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='nginx.exe'" | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress`],
      { windowsHide: true, encoding: 'utf8' }
    )
    const parsed = stdout.trim()
    if (!parsed) return { ok: false, output: 'nginx 未运行' }
    const raw = JSON.parse(parsed)
    const processes = (Array.isArray(raw) ? raw : [raw]).filter((item: any) => (
      item?.ProcessId
      && (!item.ExecutablePath || normalizePath(item.ExecutablePath) === normalizePath(settings.nginxPath))
    ))
    if (!processes.length) return { ok: false, output: 'nginx 未运行' }
    const ids = new Set(processes.map((item: any) => Number(item.ProcessId)))
    const masters = processes.filter((item: any) => !ids.has(Number(item.ParentProcessId)))
    const master = (masters.length ? masters : processes).sort((a: any, b: any) => Number(a.ProcessId) - Number(b.ProcessId))[0]
    const pidFile = join(dirname(settings.nginxPath), 'logs', 'nginx.pid')
    let current = ''
    try { current = readFileSync(pidFile, 'utf8').trim() } catch {}
    if (current === String(master.ProcessId)) return { ok: true }
    mkdirSync(dirname(pidFile), { recursive: true })
    writeFileSync(pidFile, String(master.ProcessId))
    return { ok: true }
  } catch (error) {
    return { ok: false, output: (error as Error).message }
  }
}

async function reloadNginx(settings: AppSettings) {
  const pid = await ensureNginxPid(settings)
  if (!pid.ok) return { ok: false, output: pid.output || 'nginx 未运行' }
  return runNginx(['-s', 'reload'], settings)
}

async function runNginx(args, settings) {
  const nginxPath = settings?.nginxPath
  if (!nginxPath) return { ok: false, output: '未配置 nginx 可执行文件' }
  const isScript = /\.(bat|cmd)$/i.test(nginxPath)
  try {
    const { stdout, stderr } = await execFileAsync(nginxPath, args, {
      cwd: existsSync(dirname(nginxPath)) ? dirname(nginxPath) : undefined,
      windowsHide: true,
      timeout: 20000,
      encoding: 'buffer',
      shell: isScript
    })
    return { ok: true, output: `${decodeOutput(stdout)}${decodeOutput(stderr)}`.trim() }
  } catch (error) {
    const output = `${decodeOutput(error.stdout)}${decodeOutput(error.stderr)}`.trim()
    return { ok: false, output: output || error.message }
  }
}

export async function nginxRunning() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq nginx.exe', '/FO', 'CSV', '/NH'], {
        windowsHide: true,
        encoding: 'buffer'
      })
      return /nginx\.exe/i.test(decodeOutput(stdout))
    }
    await execFileAsync('pgrep', ['-x', 'nginx'])
    return true
  } catch {
    return false
  }
}


async function findNginxPath() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-Command', "(Get-Process nginx -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)"],
        { windowsHide: true, encoding: 'utf8' }
      )
      return stdout.trim()
    }
    const { stdout } = await execFileAsync('which', ['nginx'], { encoding: 'utf8' })
    return stdout.trim()
  } catch {
    return ''
  }
}

async function startNginx(settings: AppSettings) {
  if (!settings.nginxPath) return { ok: false, output: '未配置 nginx 可执行文件' }
  if (await nginxRunning()) return { ok: true, output: 'nginx 已在运行' }
  const cwd = existsSync(dirname(settings.nginxPath)) ? dirname(settings.nginxPath) : undefined
  const isScript = /\.(bat|cmd)$/i.test(settings.nginxPath)
  try {
    const child = spawn(settings.nginxPath, [], {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: isScript
    })
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      setTimeout(resolve, 600)
    })
    child.unref()
    await new Promise(resolve => setTimeout(resolve, 600))
    const running = await nginxRunning()
    return running
      ? { ok: true, output: 'nginx 已启动' }
      : { ok: false, output: 'nginx 启动后未检测到进程，请检查 nginx 配置或路径' }
  } catch (error) {
    return { ok: false, output: (error as Error).message }
  }
}

function describeApplied(result: any) {
  const applied = Array.isArray(result?.applied) ? result.applied : []
  const names = applied.map((item: any) => item.path)
  if (applied.length === 1) {
    const change = applied[0]
    const entry = (result.entries || []).find((item: any) => item.path === change.path)
    const target = change.mode === 'local' ? entry?.local : entry?.remote
    return {
      title: `模块[${change.path}] ${change.mode === 'local' ? '切换本地' : '切换远程'}`,
      body: target || ''
    }
  }
  const modes = new Set(applied.map((item: any) => item.mode))
  if (modes.size === 1) {
    const mode = [...modes][0]
    return {
      title: `${applied.length} 个模块${mode === 'local' ? '切换本地' : '切换远程'}`,
      body: names.join('、')
    }
  }
  return { title: `已更新 ${applied.length} 个模块`, body: names.join('、') }
}

function describeBody(result: any) {
  const detail = describeApplied(result)
  const suffix = result?.reload ? '\nNginx 重载中…' : ''
  return { title: detail.title, body: `${detail.body}${suffix}`.trim() }
}


function connectHost(host: string, port: number, timeout: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port })
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeout, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

async function candidateHosts(hostname: string): Promise<string[]> {
  if (hostname === 'localhost') return ['127.0.0.1', '::1']
  try {
    const addresses = await lookup(hostname, { all: true })
    return [...new Set(addresses.map(item => item.address))]
  } catch {
    return [hostname]
  }
}

async function portAvailable(url: string, timeout: number): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
  for (const host of await candidateHosts(parsed.hostname)) {
    if (await connectHost(host, port, timeout)) return true
  }
  return false
}

async function fetchAvailable(url: string, timeout: number): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout)
    })
    return response.status < 400
  } catch {
    return false
  }
}

async function localAvailable(url: string, type = 'request', timeout = 1500): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false
  if (type === 'port') return portAvailable(url, timeout)
  if (await fetchAvailable(url, timeout)) return true
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'localhost') return false
    for (const host of ['127.0.0.1', '[::1]']) {
      const candidate = new URL(url)
      candidate.hostname = host
      if (await fetchAvailable(candidate.toString(), timeout)) return true
    }
  } catch {}
  return false
}

async function detectChanges(entries, type = 'request') {
  return Promise.all(entries.map(async entry => {
    const available = await localAvailable(entry.local, type)
    const desired = available ? 'local' : 'remote'
    return {
      path: entry.path,
      mode: desired,
      remote: entry.remote,
      local: entry.local,
      localAvailable: available,
      currentMode: entry.isRemote ? 'remote' : 'local',
      changed: (entry.isRemote ? 'remote' : 'local') !== desired
    }
  }))
}

// 原项目的应用图标，随包发布，弹窗消息用它
function appIconPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'app.ico')
}

function nativeNotify(title: string, message: string, type: 'info' | 'warning' | 'error' = 'info') {
  const text = String(message || '').slice(0, 500)
  try {
    if (process.platform === 'win32') {
      const iconPath = appIconPath()
      const script = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System.Windows.Forms;
public class WRNotifyForm : Form {
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get {
      var cp = base.CreateParams;
      cp.ExStyle |= 0x08000000 | 0x00000080;
      return cp;
    }
  }
}
'@
$form = New-Object WRNotifyForm
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(30, 32, 38)
$form.Opacity = 0.97
$form.Size = New-Object System.Drawing.Size(390, 122)
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($area.Right - 410), ($area.Bottom - 140))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 14
$path.AddArc(0, 0, $r, $r, 180, 90)
$path.AddArc($form.Width - $r, 0, $r, $r, 270, 90)
$path.AddArc($form.Width - $r, $form.Height - $r, $r, $r, 0, 90)
$path.AddArc(0, $form.Height - $r, $r, $r, 90, 90)
$path.CloseFigure()
$form.Region = New-Object System.Drawing.Region($path)
$accent = New-Object System.Windows.Forms.Panel
$accent.BackColor = [System.Drawing.Color]::FromArgb(96, 165, 250)
$accent.Location = New-Object System.Drawing.Point(0, 12)
$accent.Size = New-Object System.Drawing.Size(4, 98)
$textLeft = 20
$iconFile = '${psQuote(appIconPath())}'
if (Test-Path -LiteralPath $iconFile) {
  try {
    $icon = New-Object System.Drawing.Icon($iconFile, (New-Object System.Drawing.Size(30, 30)))
    $iconBox = New-Object System.Windows.Forms.PictureBox
    $iconBox.SizeMode = 'StretchImage'
    $iconBox.Image = $icon.ToBitmap()
    $iconBox.Location = New-Object System.Drawing.Point(18, 18)
    $iconBox.Size = New-Object System.Drawing.Size(30, 30)
    $form.Controls.Add($iconBox)
    $textLeft = 60
  } catch {}
}
$titleLabel = New-Object System.Windows.Forms.Label
$titleLabel.Text = '${psQuote(title)}'
$titleLabel.ForeColor = [System.Drawing.Color]::White
$titleLabel.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
$titleLabel.Location = New-Object System.Drawing.Point($textLeft, 16)
$titleLabel.Size = New-Object System.Drawing.Size(370 - $textLeft, 24)
$messageLabel = New-Object System.Windows.Forms.Label
$messageLabel.Text = '${psQuote(text)}'
$messageLabel.ForeColor = [System.Drawing.Color]::FromArgb(196, 203, 214)
$messageLabel.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$messageLabel.Location = New-Object System.Drawing.Point($textLeft, 44)
$messageLabel.Size = New-Object System.Drawing.Size(370 - $textLeft, 64)
$form.Controls.Add($accent)
$form.Controls.Add($titleLabel)
$form.Controls.Add($messageLabel)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5200
$timer.Add_Tick({ $form.Close() })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
$timer.Dispose()
$form.Dispose()`
      spawn('powershell.exe', ['-STA', '-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      }).unref()
      return
    }
    if (process.platform === 'darwin') {
      const script = `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref()
      return
    }
    spawn('notify-send', [title, text], { detached: true, stdio: 'ignore' }).unref()
  } catch {}
}


async function atomicWrite(file: string, text: string) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, text, 'utf8')
  try {
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

export async function readDocument(settings: AppSettings = loadSettings()) {
  if (!settings.confPath) return { settings, text: '', entries: [], error: '还没有选择 nginx 配置文件' }
  if (!existsSync(settings.confPath)) return { settings, text: '', entries: [], error: `配置文件不存在: ${settings.confPath}` }
  const text = await readFile(settings.confPath, 'utf8')
  const doc = NginxConfigDocument.parse(text)
  return { settings, text, entries: doc.entries, error: '' }
}

let saveChain: Promise<unknown> = Promise.resolve()

export function saveEntries<T>(changes: any[], options?: any): Promise<T> {
  const run = saveChain.then(
    () => saveEntriesUnlocked(changes, options),
    () => saveEntriesUnlocked(changes, options)
  ) as Promise<T>
  saveChain = run.catch(() => {})
  return run
}

async function saveEntriesUnlocked(changes: any[], { reloadAfter = true } = {}) {
  const settings = loadSettings()
  if (!settings.confPath) throw new Error('还没有选择 nginx 配置文件')
  const original = await readFile(settings.confPath, 'utf8')
  const doc = NginxConfigDocument.parse(original)
  const applied: Array<{ path: string; mode: string }> = []
  const skipped: string[] = []

  for (const change of changes || []) {
    const path = String(change.path || '')
    const mode = change.mode === 'local' ? 'local' : 'remote'
    const remote = String(change.remote || '').trim()
    const local = String(change.local || '').trim()
    if (!path || !remote || !local) {
      skipped.push(path || '(空)')
      continue
    }
    if (doc.setEntry(path, mode, remote, local)) applied.push({ path, mode })
    else skipped.push(path)
  }

  if (!applied.length) {
    return { ok: false, error: skipped.length ? `已跳过 ${skipped.length} 项（缺少地址或模块不存在）` : '没有可保存的修改', skipped }
  }

  await atomicWrite(settings.confPath, doc.text())

  if (!settings.nginxPath) {
    return {
      ok: true,
      validated: false,
      reload: null,
      output: '未配置 nginx，已直接写入，跳过校验与重载',
      entries: doc.entries,
      applied,
      skipped,
      settings
    }
  }

  const validation = await runNginx(['-t'], settings)
  if (!validation.ok) {
    await atomicWrite(settings.confPath, original)
    return {
      ok: false,
      stage: 'validate',
      output: validation.output,
      rolledBack: true,
      entries: NginxConfigDocument.parse(original).entries,
      applied: [],
      skipped,
      settings
    }
  }

  let reload = null
  if (reloadAfter && settings.syncReload) {
    reload = await reloadNginx(settings)
  }

  return {
    ok: true,
    validated: true,
    validation,
    reload,
    output: validation.output,
    entries: doc.entries,
    applied,
    skipped,
    settings
  }
}

// ============================================================
// 自动代理轮询
// ============================================================
const autoState = {
  enabled: false,
  checking: false,
  lastCheckAt: 0,
  lastChangeAt: 0,
  lastOutput: '',
  error: ''
}
let autoTimer = null
let autoPromise = null
let autoCooldownUntil = 0

async function runAutoCheck() {
  if (autoPromise) return autoPromise
  autoPromise = (async () => {
    const settings = loadSettings()
    if (!settings.autoProxyEnabled) {
      autoState.enabled = false
      return autoState
    }
    if (Date.now() < autoCooldownUntil) return autoState
    autoState.enabled = true
    autoState.checking = true
    autoState.error = ''
    try {
      const document = await readDocument(settings)
      if (document.error) {
        autoState.error = document.error
        return autoState
      }
      const results = await detectChanges(document.entries, settings.autoProxyType)
      const changes = results.filter(change => change.changed)
      autoState.lastCheckAt = Date.now()
      if (!changes.length) {
        autoState.lastOutput = '已检查，无需切换'
        return autoState
      }
      const result = await saveEntries<any>(changes, { reloadAfter: true })
      if (result.ok) {
        const count = result.applied?.length || 0
        autoState.lastChangeAt = Date.now()
        autoState.lastOutput = `自动切换 ${count} 个模块`
        const message = describeBody(result)
        nativeNotify(message.title, message.body, 'info')
      } else {
        autoState.error = result.output || result.error || '自动切换失败'
        autoState.lastOutput = '自动切换失败'
        autoCooldownUntil = Date.now() + 15000
        nativeNotify('配置校验失败（已回滚）', autoState.error, 'error')
      }
    } catch (error) {
      autoState.error = (error as Error).message
      autoState.lastOutput = '自动切换失败'
      autoCooldownUntil = Date.now() + 15000
      nativeNotify('自动代理失败', (error as Error).message, 'error')
    } finally {
      autoState.checking = false
    }
    return autoState
  })()
  try {
    return await autoPromise
  } finally {
    autoPromise = null
  }
}

function restartAuto() {
  const settings = loadSettings()
  clearInterval(autoTimer)
  autoTimer = null
  autoState.enabled = settings.autoProxyEnabled
  if (!settings.autoProxyEnabled) return autoState
  runAutoCheck().catch(() => {})
  autoTimer = setInterval(() => { runAutoCheck().catch(() => {}) }, settings.autoProxyInterval)
  return autoState
}

function stopAuto() {
  clearInterval(autoTimer)
  autoTimer = null
  autoState.enabled = false
}

// ============================================================
// 文件选择
// ============================================================
function psQuote(value) {
  return String(value).replace(/'/g, "''")
}

async function pickFile(kind) {
  if (process.platform !== 'win32') throw new Error('文件选择器仅支持 Windows')
  const filter = kind === 'exe'
    ? "可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*"
    : "Nginx 配置 (*.conf)|*.conf|所有文件 (*.*)|*.*"
  const title = kind === 'exe' ? '选择 nginx.exe' : '选择 nginx 配置文件'
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '${psQuote(title)}'
$dialog.Filter = '${filter}'
$dialog.CheckFileExists = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.FileName)
}
`
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', script],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  )
  return stdout.trim()
}

// ============================================================
// 本地 HTTP 服务
// ============================================================
function send(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(value))
}

function allowedOrigin(origin) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function bootstrap() {
  let settings = loadSettings()
  if (!settings.nginxPath) {
    const detected = await findNginxPath()
    if (detected) {
      settings = { ...settings, nginxPath: detected }
      persistSettings({ nginxPath: detected })
    }
  }
  const document = await readDocument(settings)
  return {
    settings: document.settings,
    entries: document.entries,
    text: document.text,
    error: document.error,
    nginxRunning: await nginxRunning(),
    autoState: { ...autoState }
  }
}

export async function handleAction(action: string, payload: any = {}) {
  switch (action) {
    case 'bootstrap':
      return bootstrap()
    case 'load':
      return readDocument()
    case 'status':
      return { nginxRunning: await nginxRunning(), autoState: { ...autoState } }
    case 'auto-proxy': {
      const settings = persistSettings({ autoProxyEnabled: Boolean(payload.enabled) })
      if (settings.autoProxyEnabled) restartAuto()
      else stopAuto()
      return { settings, autoState: { ...autoState } }
    }
    case 'save': {
      const result = await saveEntries<any>(payload.changes || [], { reloadAfter: payload.reloadAfter !== false })
      if (result.ok) {
        const message = describeBody(result)
        nativeNotify(message.title, message.body, 'info')
      } else {
        nativeNotify('配置校验失败（已回滚）', result.output || result.error || '保存失败', 'error')
      }
      return result
    }
    case 'nginx': {
      const settings = loadSettings()
      const allowed = { validate: ['-t'], reload: ['-s', 'reload'], start: [], stop: null }
      if (!(payload.action in allowed)) throw new Error(`未知 nginx 操作: ${payload.action}`)
      if (payload.action === 'start') {
        const result = await startNginx(settings)
        if (!result.ok) nativeNotify('Nginx 启动失败', result.output, 'error')
        return result
      }
      if (payload.action === 'stop') {
        if (process.platform === 'win32') {
          try {
            await execFileAsync('taskkill', ['/F', '/IM', 'nginx.exe'], { windowsHide: true })
            return { ok: true, output: 'nginx 已停止' }
          } catch (error) {
            return { ok: false, output: error.message }
          }
        }
        try {
          await execFileAsync('pkill', ['-9', 'nginx'])
          return { ok: true, output: 'nginx 已停止' }
        } catch (error) {
          return { ok: false, output: error.message }
        }
      }
      const result = payload.action === 'reload'
        ? await reloadNginx(settings)
        : await runNginx(allowed[payload.action], settings)
      if (!result.ok) nativeNotify('Nginx 操作失败', result.output || `${payload.action} 失败`, 'error')
      return result
    }
    case 'pick':
      return { path: await pickFile(payload.kind === 'exe' ? 'exe' : 'conf') }
    case 'notify':
      nativeNotify(
        String(payload.title || 'Nginx 代理'),
        String(payload.message || '系统通知'),
        payload.type === 'error' ? 'error' : payload.type === 'warning' ? 'warning' : 'info'
      )
      return { ok: true }
    case 'settings': {
      const settings = persistSettings(payload.patch || {})
      restartAuto()
      const document = await readDocument(settings)
      return {
        settings: document.settings,
        entries: document.entries,
        text: document.text,
        error: document.error,
        autoState: { ...autoState }
      }
    }
    case 'source':
      return readDocument().then(document => ({ text: document.text, error: document.error }))
    case 'detect': {
      const document = await readDocument()
      if (document.error) throw new Error(document.error)
      const settings = loadSettings()
      const changes = await detectChanges(document.entries, settings.autoProxyType)
      return { changes }
    }
    default:
      throw new Error(`未知操作: ${action}`)
  }
}

function createRpcServer() {
  return createServer(async (req, res) => {
    const origin = req.headers.origin || ''
    if (allowedOrigin(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
    }
    res.setHeader('access-control-allow-headers', 'content-type,x-proxy-cfg-token')
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      return res.end()
    }
    if (req.headers['x-proxy-cfg-token'] !== TOKEN) {
      return send(res, 403, { error: 'forbidden' })
    }
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true })
    }
    if (req.method === 'POST' && req.url === '/rpc') {
      try {
        const body = await readBody(req)
        const result = await handleAction(String(body.action || ''), body.payload || {})
        return send(res, 200, { result })
      } catch (error) {
        return send(res, 400, { error: error.message })
      }
    }
    return send(res, 404, { error: 'not found' })
  })
}

const service = createRpcServer()
let servicePromise = null
let activeMounts = 0
let closeTimer = null

function listen(server, port, attempts = 4): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = error => {
      server.removeListener('listening', onListening)
      if (error.code === 'EADDRINUSE' && attempts > 1) {
        setTimeout(() => listen(server, port, attempts - 1).then(resolve, reject), 250)
        return
      }
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

async function ensureService() {
  if (!servicePromise) {
    servicePromise = listen(service, PORT).catch(error => {
      servicePromise = null
      throw error
    })
  }
  await servicePromise
  return service
}

export async function apply(ctx) {
  activeMounts += 1
  clearTimeout(closeTimer)
  closeTimer = null
  try {
    await ensureService()
    restartAuto()
    console.log('[la-proxy-cli] local service ready')
  } catch (error) {
    console.error('[la-proxy-cli] 本地服务启动失败:', error.message)
  }
  ctx?.on?.('dispose', () => {
    stopAuto()
    activeMounts = Math.max(0, activeMounts - 1)
    if (activeMounts > 0) return
    closeTimer = setTimeout(() => {
      if (activeMounts > 0 || !service.listening) return
      service.closeAllConnections?.()
      service.close()
      servicePromise = null
    }, 800)
  })
}

process.once('exit', () => {
  if (service.listening) {
    service.closeAllConnections?.()
    service.close()
  }
})

export default { name, apply }
