/**
 * 与插件自己的 Node half 通信（本地 HTTP，token 校验）。
 */
const PORT = Number(import.meta.env?.VITE_WR_PROXY_CFG_PORT || 38472)
const TOKEN = 'wr-proxy-cfg-local'

async function call<T = any>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-proxy-cfg-token': TOKEN,
    },
    body: JSON.stringify({ action, payload }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.error) throw new Error(data.error || `请求失败: ${response.status}`)
  return data.result as T
}

export const service = {
  bootstrap: () => call('bootstrap'),
  load: () => call('load'),
  status: () => call('status'),
  autoProxy: (enabled: boolean) => call('auto-proxy', { enabled }),
  save: (payload: Record<string, unknown>) => call('save', payload),
  pickFile: (kind: 'exe' | 'conf') => call<{ path: string }>('pick', { kind }),
  saveSettings: (patch: Record<string, unknown>) => call('settings', { patch }),
  nginx: (action: string) => call('nginx', { action }),
  source: () => call('source'),
  detect: () => call('detect'),
  notify: (title: string, message: string, type = 'info') => call('notify', { title, message, type }),
}

export default service
