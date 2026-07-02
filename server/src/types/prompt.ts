/**
 * 系统提示词构建器类型定义
 * 
 * 遵循 SOLID 原则：
 * - ISP (Interface Segregation)：每个接口只定义最小必要契约
 * - OCP (Open/Closed)：通过 PromptSection 插件机制扩展，无需修改核心构建器
 * - DIP (Dependency Inversion)：高层模块依赖 IPromptSection 抽象，不依赖具体实现
 */

/** 提示词片段的优先级（影响排列顺序） */
export type PromptPriority = 'static' | 'low-churn' | 'dynamic';

/** 提示词片段构建上下文 —— 只传递必要信息（ISP） */
export interface PromptBuildContext {
    userId: string;
    workspaceRoot: string;
    locale: string;
    /** 环境元信息（OS/Node/Java/PowerShell 等） */
    envInfo: Record<string, any>;
    /** 项目语言版本约束 */
    projectVersions: {
        java?: string | null;
        python?: string | null;
        go?: string | null;
    };
    /** Maven/Gradle 项目源文件编码 */
    projectSourceEncoding?: string | null;
    /** 是否为 Maven 项目 */
    isMavenProject: boolean;
    /** 当前日期（已格式化） */
    localDate: string;
    /** 时区标识 */
    localTimeZone: string;
    /** Agent 配置文件名（如 main-agent.json） */
    agentConfigFile: string;
}

/**
 * 提示词片段插件接口 (ISP + OCP)
 * 
 * 每个 PromptSection 负责生成系统提示词的一个独立模块。
 * 新增策略/契约只需实现此接口并注册到 SystemPromptBuilder。
 */
export interface IPromptSection {
    /** 片段唯一标识（用于调试和日志） */
    readonly id: string;
    /** 优先级分组：static → 靠前、low-churn → 中部、dynamic → 靠后 */
    readonly priority: PromptPriority;
    /**
     * 构建此片段的提示词内容。
     * @returns 提示词文本；返回空字符串则表示跳过此片段
     */
    build(ctx: PromptBuildContext): Promise<string>;
}

/**
 * 组合式提示词片段：由多个子片段组成，按 priority 分组排列
 */
export interface ICompositePromptSection extends IPromptSection {
    /** 注册子片段 */
    register(section: IPromptSection): void;
    /** 移除子片段 */
    unregister(sectionId: string): boolean;
}
