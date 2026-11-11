# la-proxy-cli

Lucky Apps 内置插件（重建版）：本地 nginx 反向代理配置管理。

- **Node half**（`src/node.ts`）：读写 nginx conf、`nginx -t` 校验、reload/start/stop、
  自动检测本地服务并切换、Windows 原生通知。通过本地 HTTP `/rpc`（token 校验）暴露给前端。
- **nginx 生命周期**：插件加载时自动启动 nginx；插件卸载、宿主正常退出时关闭；宿主被强杀时由
  watchdog 进程收尾。`WR_PARENT_PID` 存在时监听宿主进程，否则监听 Node 服务进程。
- **Client half**（`src/ProxyCfgPage.vue`）：导航页「Nginx 代理」，模块卡片、批量切换、
  源码高亮、本地服务检测与设置弹窗。
- 设置持久化在 `%APPDATA%/week-report-proxy-cfg/config.json`，可导入旧 `proxy_cfg_cli/config.ini`。
- 通知图标在 `public/app.ico`，构建时复制到 `lib/app.ico`；Node half 直接读 `lib/app.ico`。

```bash
pnpm install
pnpm build        # lib/client.js + lib/node.js + app.ico
```
