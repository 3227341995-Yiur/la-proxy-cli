import { defineConfig, build as viteBuild, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const name = 'la-proxy-cli'

function cssInjectedByJs(): Plugin {
  return {
    name: 'css-injected-by-js',
    apply: 'build',
    async writeBundle(options, bundle) {
      const outDir = options.dir
      if (!outDir) return
      const cssFiles = Object.keys(bundle).filter(file => file.endsWith('.css'))
      if (!cssFiles.length) return
      let css = ''
      for (const file of cssFiles) {
        css += await readFile(path.join(outDir, file), 'utf8')
        await rm(path.join(outDir, file), { force: true })
      }
      const jsPath = path.join(outDir, 'client.js')
      let js = await readFile(jsPath, 'utf8')
      js += `
;(() => {
  if (document.querySelector('style[data-extension="${name}"]')) return
  const style = document.createElement('style')
  style.dataset.extension = '${name}'
  style.textContent = ${JSON.stringify(css)}
  document.head.appendChild(style)
})();
`
      await writeFile(jsPath, js)
    },
  }
}

// 同一个标准 Vite 项目里顺带产出 Node half（ESM），不额外维护第二份 config。
function clientModuleBundle(name: string): Plugin {
  return {
    name: 'lucky-apps-client-bundle',
    apply: 'build',
    enforce: 'post',
    async writeBundle(options) {
      const outDir = options.dir
      if (!outDir) return
      const file = path.join(outDir, 'client.js')
      const js = await readFile(file, 'utf8').catch(() => '')
      if (!js || js.includes('__ModuleLoader__')) return
      await writeFile(file, `window.__ModuleLoader__.load({
  id: ${JSON.stringify(name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${js}
    return module.exports;
  }
});
`)
    },
  }
}

function nodeHalf(): Plugin {
  return {
    name: 'cordis-node-half',
    apply: 'build',
    async closeBundle() {
      await viteBuild({
        configFile: false,
        logLevel: 'warn',
        build: {
          outDir: path.resolve(root, 'lib'),
          emptyOutDir: false,
          minify: false,
          target: 'node22',
          ssr: true,
          lib: {
            entry: path.resolve(root, 'src/node.ts'),
            formats: ['esm'],
            fileName: () => 'node.js',
          },
          rollupOptions: { external: [/^node:/] },
        },
      })
    },
  }
}

export default defineConfig({
  plugins: [vue(), cssInjectedByJs(), clientModuleBundle(name), nodeHalf()],
  build: {
    outDir: path.resolve(root, 'lib'),
    emptyOutDir: false,
    cssCodeSplit: false,
    minify: false,
    lib: {
      entry: path.resolve(root, 'src/index.ts'),
      formats: ['cjs'],
      fileName: () => 'client.js',
    },
    rollupOptions: {
      external: ['vue', 'element-plus', '@element-plus/icons-vue', '@lucky-apps/client-ui'],
    },
  },
})
