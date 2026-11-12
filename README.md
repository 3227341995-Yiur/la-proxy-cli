# la-proxy-cli

Lucky Apps 外部插件：本地 nginx 反向代理配置管理。

## 安装

在 Lucky Apps「设置 → 扩展 → 安装外部组件」中粘贴本仓库地址
`https://github.com/3227341995-Yiur/la-proxy-cli`，或安装 npm 包 / 本地目录。

插件作为标准 Cordis bundle 挂载，安装后在导航栏出现「Nginx 代理」。

## 功能

- **Node half**（`src/node.ts`）：读写 nginx conf、`nginx -t` 校验、reload / start / stop、
  自动检测本地服务并切换。通过本地 HTTP `/rpc`（token 校验）暴露给前端。
- **nginx 生命周期**：插件加载时自动启动 nginx；插件卸载、宿主正常退出时关闭；宿主被强杀时由
  watchdog 进程收尾。`WR_PARENT_PID` 存在时监听宿主进程，否则监听 Node 服务进程。
- **自动代理**：按间隔检测各模块的本地地址，自动切换并保存；校验失败自动回滚。
- **系统通知**：Windows 使用 WinRT Toast（AUMID `com.lu.lucky-apps`），macOS 使用系统通知中心；
  自动切换、手动切换、自动代理开关、保存或校验失败都会提示。
- **Client half**（`src/ProxyCfgPage.vue`）：导航页「Nginx 代理」，模块卡片、批量切换、
  源码高亮、本地服务检测与设置弹窗。弹窗统一使用 `@lucky-apps/client-ui` 的 `AppDialog`；
  构建时标为 external，运行时由宿主 `window.__ModuleLoader__` staticModules 提供。
- 设置持久化在 `%APPDATA%/week-report-proxy-cfg/config.json`
  （可用 `WR_PROXY_CFG_DATA` 覆盖），支持从 `proxy_cfg_cli/config.ini` 导入现有配置。
  服务端口 `38472`（可用 `WR_PROXY_CFG_PORT` 覆盖）。
- 通知图标在 `public/app.ico`，构建时复制到 `lib/app.ico`。

```bash
pnpm install
pnpm build        # lib/client.js + lib/node.js + app.ico
```
