import React, { useState, useEffect, useRef } from 'react';
import { Search, FileText, Loader2, Box, Code } from 'lucide-react';
import { useAgentContext } from '@/providers/AgentContext';
import { electronBridge } from '@/services/electron-bridge';

interface SearchPanelProps {
  onFileSelect: (path: string) => void;
  activeFile: string;
}

interface SearchResultItem {
  path: string;
  line: number;
  content: string;
}

/**
 * 侧边栏全局搜索面板
 * 支持输入关键词模糊搜索工作区文件与内容
 */
export const SearchPanel: React.FC<SearchPanelProps> = ({ onFileSelect, activeFile }) => {
  const { workspaceRoot } = useAgentContext();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef<number>(0);

  // 自动聚焦输入框
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 防抖搜索与竞态保护
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    const trimmed = query.trim();
    if (!trimmed || !workspaceRoot) {
      setResults([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    const currentSeq = ++searchSeqRef.current;

    debounceTimer.current = setTimeout(async () => {
      try {
        const result = await electronBridge.searchFiles({
          pattern: trimmed,
          root: workspaceRoot,
          maxResults: 100,
        });

        // 仅在当前请求未被后续搜索覆盖时更新状态
        if (currentSeq === searchSeqRef.current) {
          if (result.success && Array.isArray(result.results)) {
            setResults(result.results);
          } else {
            setResults([]);
          }
        }
      } catch {
        if (currentSeq === searchSeqRef.current) {
          setResults([]);
        }
      } finally {
        if (currentSeq === searchSeqRef.current) {
          setIsLoading(false);
        }
      }
    }, 250);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query, workspaceRoot]);

  // 从绝对路径中提取相对路径用于展示
  const getDisplayPath = (absPath: string) => {
    if (!workspaceRoot) return absPath;
    const normRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    const normPath = absPath.replace(/\\/g, '/');
    if (normPath.toLowerCase().startsWith(normRoot.toLowerCase())) {
      return normPath.slice(normRoot.length).replace(/^\//, '');
    }
    return absPath;
  };

  const getFileName = (absPath: string) => {
    const segments = absPath.replace(/\\/g, '/').split('/');
    return segments[segments.length - 1] || absPath;
  };

  const getDirPath = (absPath: string) => {
    const rel = getDisplayPath(absPath);
    const segments = rel.split('/');
    if (segments.length <= 1) return '';
    return segments.slice(0, -1).join('/');
  };

  const handleClear = () => {
    setQuery('');
    setResults([]);
    setIsLoading(false);
    searchSeqRef.current++;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    inputRef.current?.focus();
  };

  return (
    <div className="flex flex-col h-full bg-[#080808]/40" data-testid="search-panel">
      {/* 搜索输入框 */}
      <div className="px-3 py-2 border-b border-white/5">
        <div className="relative flex items-center">
          {isLoading ? (
            <Loader2 size={10} className="absolute left-2.5 text-white/40 animate-spin" />
          ) : (
            <Search size={10} className="absolute left-2.5 text-white/30" />
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入关键词搜索文件或内容..."
            className="w-full bg-white/5 border border-white/10 h-7 pl-7 pr-7 text-[10px] text-white placeholder:text-white/20 focus:outline-none focus:border-white/30 transition-colors font-medium tracking-tight"
          />
          {query && (
            <button
              onClick={handleClear}
              className="absolute right-2 text-white/30 hover:text-white/60 text-[14px] leading-none"
              title="清除搜索"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* 结果列表 */}
      <div className="flex-1 overflow-y-auto">
        {!query && (
          <div className="flex flex-col items-center justify-center h-full gap-3 opacity-20">
            <Search size={28} className="text-white" />
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-white">
              输入关键词以搜索文件
            </div>
          </div>
        )}

        {query && isLoading && results.length === 0 && (
          <div className="flex items-center justify-center py-8 gap-2 text-white/30">
            <Loader2 size={10} className="animate-spin" />
            <span className="text-[9px] font-black uppercase tracking-widest">搜索中...</span>
          </div>
        )}

        {query && !isLoading && results.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 gap-3 opacity-20">
            <Box size={20} className="text-white" />
            <div className="text-[9px] font-black uppercase tracking-[0.2em] text-white">
              未找到匹配文件
            </div>
          </div>
        )}

        {results.length > 0 && (
          <div className="py-1">
            <div className="px-3 py-1.5 flex items-center justify-between text-[8px] font-black text-white/20 uppercase tracking-[0.2em]">
              <span>搜索结果 ({results.length})</span>
              {isLoading && <Loader2 size={8} className="animate-spin text-white/40" />}
            </div>
            {results.map((item: SearchResultItem, index: number) => {
              const isActive = activeFile === item.path;
              const fileName = getFileName(item.path);
              const dirPath = getDirPath(item.path);
              const isContentMatch = item.line > 0;

              return (
                <div
                  key={`${item.path}:${item.line}:${index}`}
                  onClick={() => onFileSelect(item.path)}
                  className={`flex items-start gap-2 px-3 py-1.5 cursor-pointer transition-colors group ${
                    isActive ? 'bg-white/10 text-white' : 'hover:bg-white/5 text-white/60 hover:text-white'
                  }`}
                >
                  {isContentMatch ? (
                    <Code size={10} className={`shrink-0 mt-0.5 ${isActive ? 'text-white' : 'text-white/30 group-hover:text-white/60'}`} />
                  ) : (
                    <FileText size={10} className={`shrink-0 mt-0.5 ${isActive ? 'text-white' : 'text-white/30 group-hover:text-white/60'}`} />
                  )}
                  <div className="flex flex-col min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={`text-[10px] truncate font-medium tracking-tight ${isActive ? 'font-black' : ''}`}>
                        {fileName}
                      </span>
                      {isContentMatch && (
                        <span className="shrink-0 text-[8px] bg-white/10 px-1 py-0.2 rounded text-white/70 font-mono">
                          L{item.line}
                        </span>
                      )}
                    </div>
                    {isContentMatch && item.content && (
                      <span className="text-[8px] text-white/40 truncate font-mono mt-0.5 group-hover:text-white/60">
                        {item.content}
                      </span>
                    )}
                    {dirPath && (
                      <span className="text-[8px] text-white/20 truncate font-mono">
                        {dirPath}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
