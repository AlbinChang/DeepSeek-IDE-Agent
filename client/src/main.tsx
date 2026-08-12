import { createRoot } from 'react-dom/client'
import '@/index.css'
import App from '@/App.tsx'
import { AgentProvider } from '@/providers/AgentContext.tsx'
import { ErrorBoundary } from '@/components/ErrorBoundary.tsx'
import { USER_ID } from '@/config'

/**
 * ⚠️ 已移除手动 MonacoEnvironment 配置
 * 因为 vite-plugin-monaco-editor 插件会自动代理这些请求。
 * 如果保留这里的 .bundle.js 映射，会导致 Vite 发起对不存在路径的请求，
 * 触发 Vite 的单页路由重定向，返回 index.html (MIME 为 text/html)，
 * 从而产生 "Strict MIME type checking" 报错。
 */

/**
 * ⚠️ 不启用 <StrictMode>：@monaco-editor/react 4.7 与 React 19 StrictMode 的
 * 双挂载机制不兼容 —— 首次挂载创建的 Monaco 实例会在 StrictMode 的模拟卸载中
 * 被 dispose，而组件内部的 "already created" 守卫会阻止二次创建，最终留下一个
 * 没有模型/视图的空壳编辑器（表现为内容空白、Ctrl+F 查找失效、无法编辑）。
 * 本项目对 Monaco 采用 100% 命令式生命周期管理（固定 key + 手动 setModel），
 * 与 StrictMode 的重复调用天然冲突，故开发模式亦不启用。
 */

(window as any).USER_ID = USER_ID;

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <AgentProvider>
      <App />
    </AgentProvider>
  </ErrorBoundary>,
)
