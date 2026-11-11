import { definePlugin, navigation } from 'plugin-api'
import ProxyCfgPage from './ProxyCfgPage.vue'

export default definePlugin({
  name: 'la-proxy-cli',
  inject: ['navigation'],
  apply(ctx) {
    ctx.navigation.register({
      id: 'la-proxy-cli',
      label: 'Nginx 代理',
      icon: 'Connection',
      order: 31,
      component: ProxyCfgPage,
    })
  }
})
