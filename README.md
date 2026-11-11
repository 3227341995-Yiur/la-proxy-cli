# la-proxy-cli

Lucky Apps 内置插件（重建版）：本地 nginx 反向代理配置管理。

- **Node half**（`src/node.ts`）：读写 nginx conf、`nginx -t` 校验、reload/start/stop、
  自动检测本地服务并切换、Windows 原生通知。通过本地 HTTP `/rpc`（token 校验）暴露给前端。
- **Client half**（`src/ProxyCfgPage.vue`）：导航页「Nginx 代理」，模块卡片、批量切换、
  源码高亮、本地服务检测与设置弹窗。
- 设置持久化在 `%APPDATA%/week-report-proxy-cfg/config.json`，可导入旧 `proxy_cfg_cli/config.ini`。

```bash
pnpm install
pnpm build        # lib/client.js + lib/node.js
```

> 说明：此目录在 2026-11-10 被清空后依据会话记录重建；`assets/app.ico`（通知弹窗图标）
> 未能恢复，缺失时通知会自动退回无图标布局。
