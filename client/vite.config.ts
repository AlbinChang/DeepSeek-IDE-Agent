import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import monacoEditorPlugin from 'vite-plugin-monaco-editor'
import path from 'path'
import fs from 'fs'

type ClientServerConf = {
  devPort?: number
  staticPort?: number
  host?: string
  apiPort?: number
  wsPort?: number
  terminalPort?: number
}

function loadClientServerConf(): Required<ClientServerConf> {
  const confPath = path.resolve(__dirname, 'server_conf.json')
  const defaults: Required<ClientServerConf> = {
    devPort: 5174,
    staticPort: 5174,
    host: '0.0.0.0',
    apiPort: 3001,
    wsPort: 3001,
    terminalPort: 3003,
  }

  try {
    if (!fs.existsSync(confPath)) return defaults
    const raw = fs.readFileSync(confPath, 'utf-8')
    const parsed = JSON.parse(raw) as ClientServerConf
    return {
      devPort: Number(parsed?.devPort) || defaults.devPort,
      staticPort: Number(parsed?.staticPort) || defaults.staticPort,
      host: String(parsed?.host || defaults.host),
      apiPort: Number(parsed?.apiPort) || defaults.apiPort,
      wsPort: Number(parsed?.wsPort) || defaults.wsPort,
      terminalPort: Number(parsed?.terminalPort) || defaults.terminalPort,
    }
  } catch {
    return defaults
  }
}

const clientConf = loadClientServerConf()
const heavyAsyncFeatureChunkPattern = /vendor-(monaco-editor|mermaid|cytoscape)/
const viteRuntimeHelperPattern = /vite[/\\](preload-helper|modulepreload-polyfill)|commonjsHelpers/

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    react(),
    (monacoEditorPlugin as any).default({
      // 可以在这里配置支持的语言
      languageWorkers: ['json', 'editorWorkerService', 'typescript', 'html', 'css']
    })
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    __SERVER_CONF__: JSON.stringify(clientConf),
  },
  build: {
    chunkSizeWarningLimit: 4096,
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter((dep) => !heavyAsyncFeatureChunkPattern.test(dep))
      },
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (viteRuntimeHelperPattern.test(id)) return 'vendor-vite-runtime'
          if (!id.includes('node_modules')) return undefined

          if (id.includes('uuid')) return 'vendor-id'

          if (id.includes('monaco-editor')) return 'vendor-monaco-editor'
          if (id.includes('xterm')) return 'vendor-terminal'
          if (id.includes('mermaid')) return 'vendor-mermaid'
          if (id.includes('katex')) return 'vendor-katex'
          if (id.includes('cytoscape')) return 'vendor-cytoscape'
          if (id.includes('react-markdown') || id.includes('remark-gfm')) return 'vendor-markdown'
          if (id.includes('react-syntax-highlighter') || id.includes('highlight.js') || id.includes('refractor')) return 'vendor-syntax'
          if (id.includes('react-dom') || id.includes('react')) return 'vendor-react'

          return undefined
        },
      },
    },
  },
  server: {
    port: clientConf.devPort,
    strictPort: true,
    host: clientConf.host,
    proxy: {
      '/api': {
        target: `http://localhost:${clientConf.apiPort}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://localhost:${clientConf.wsPort}`,
        ws: true,
      },
    },
  },
})
