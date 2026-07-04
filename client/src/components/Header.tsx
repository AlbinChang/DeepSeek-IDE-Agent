import React from 'react';
import { ChevronRight, Box, ArrowLeft, ArrowRight } from 'lucide-react';

interface HeaderProps {
    activeFile: string;
    onBack?: () => void;
    onForward?: () => void;
    canBack?: boolean;
    canForward?: boolean;
}

/**
 * 顶部导航与搜索栏 (对齐技术规范 第 38.0 节：Header & Navigation)
 */
export const Header: React.FC<HeaderProps> = ({ activeFile, onBack, onForward, canBack, canForward }) => {

    const pathSegments = activeFile.split('/');

    return (
        <div data-testid="header-container" className="h-[24px] w-full bg-[#000000] flex items-center justify-between px-3 select-none">
            {/* 左侧：品牌 & 历史 */}
            <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 text-white font-black tracking-tighter pr-3 border-r border-white/15 mr-1">
                    <Box size={10} />
                    <span className="text-white text-[9px] uppercase tracking-widest font-black">DeepSeek-IDE-Agent</span>
                    <span className="bg-white/5 text-white px-1 rounded-sm text-[7px] font-black opacity-80">v1.0</span>
                </div>

                <div className="flex items-center gap-1 mr-2 scale-75">
                    <button 
                        disabled={!canBack} 
                        onClick={onBack}
                        className={`p-1 rounded hover:bg-white/5 transition-colors ${canBack ? 'text-white' : 'text-white/40 cursor-not-allowed'}`}
                    >
                        <ArrowLeft size={12} />
                    </button>
                    <button 
                        disabled={!canForward} 
                        onClick={onForward}
                        className={`p-1 rounded hover:bg-white/5 transition-colors ${canForward ? 'text-white' : 'text-white/40 cursor-not-allowed'}`}
                    >
                        <ArrowRight size={12} />
                    </button>
                </div>

                <div className="flex items-center gap-1.5 text-[8.5px] text-white overflow-hidden font-black tracking-widest">
                    {pathSegments.map((seg, i) => (
                        <React.Fragment key={i}>
                            <button className="hover:text-white transition-colors truncate max-w-[750px] opacity-80 hover:opacity-100">
                                {seg}
                            </button>
                            {i < pathSegments.length - 1 && <ChevronRight size={8} className="opacity-40" />}
                        </React.Fragment>
                    ))}
                </div>
            </div>
        </div>
    );
};
