import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/index.css'
import App from '@/App.tsx'
import { AgentProvider } from '@/providers/AgentContext.tsx'
import { USER_ID } from '@/config'

/**
 * ⚠️ 已移除手动 MonacoEnvironment 配置
 * 因为 vite-plugin-monaco-editor 插件会自动代理这些请求。
 * 如果保留这里的 .bundle.js 映射，会导致 Vite 发起对不存在路径的请求，
 * 触发 Vite 的单页路由重定向，返回 index.html (MIME 为 text/html)，
 * 从而产生 "Strict MIME type checking" 报错。
 */

(window as any).USER_ID = USER_ID;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AgentProvider>
      <App />
    </AgentProvider>
  </StrictMode>,
)
