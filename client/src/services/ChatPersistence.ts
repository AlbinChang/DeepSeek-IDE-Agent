import {
  putChatMessages,
  saveChatUiState,
  type ChatMessage,
  type ChatUiState,
} from '@/services/db';

/**
 * 前端聊天内容的后台持久化队列。
 *
 * 设计目标：
 * - 与 Agent 运行生命周期解耦：用户消息、流式中的 assistant 消息、
 *   工具调用/结果、错误提示都会持续写入 IndexedDB，而不是等 done 才写。
 * - 异步 + 合并写入：同一消息在队列里只保留最新快照，按固定间隔批量落库，
 *   不阻塞 UI，也不会因为每个 token 都写库而拖慢长任务。
 * - 只在用户显式点击「清空历史会话」时由调用方清空数据；
 *   本类不包含任何自动删除逻辑。
 */

const MESSAGE_FLUSH_INTERVAL_MS = 800;
const UI_STATE_FLUSH_INTERVAL_MS = 1200;

export class ChatPersistence {
  private pendingMessages = new Map<string, ChatMessage>();
  private messageTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUiState: ChatUiState | null = null;
  private uiTimer: ReturnType<typeof setTimeout> | null = null;
  /** 串行化 IndexedDB 写事务，避免同一消息的旧快照覆盖新快照 */
  private writeChain: Promise<void> = Promise.resolve();

  scheduleMessage(message: ChatMessage, options: { immediate?: boolean } = {}): void {
    if (!message?.id || !message.workspaceRoot) return;
    this.pendingMessages.set(message.id, message);
    if (options.immediate) {
      void this.flushMessages();
      return;
    }
    this.armMessageTimer();
  }

  scheduleUiState(state: ChatUiState, options: { immediate?: boolean } = {}): void {
    if (!state?.workspaceKey && !state?.workspaceRoot) return;
    this.pendingUiState = state;
    if (options.immediate) {
      void this.flushUiState();
      return;
    }
    this.armUiTimer();
  }

  /** 立即落库全部待写内容（页面隐藏 / 关闭 / 清空前调用）。 */
  async flush(): Promise<void> {
    await Promise.all([this.flushMessages(), this.flushUiState()]);
  }

  /** 丢弃尚未写入的快照（仅用于清空会话，避免清空后又被旧快照写回）。 */
  clearPending(): void {
    if (this.messageTimer !== null) {
      clearTimeout(this.messageTimer);
      this.messageTimer = null;
    }
    if (this.uiTimer !== null) {
      clearTimeout(this.uiTimer);
      this.uiTimer = null;
    }
    this.pendingMessages.clear();
    this.pendingUiState = null;
  }

  private armMessageTimer(): void {
    if (this.messageTimer !== null) return;
    this.messageTimer = setTimeout(() => {
      this.messageTimer = null;
      void this.flushMessages();
    }, MESSAGE_FLUSH_INTERVAL_MS);
  }

  private armUiTimer(): void {
    if (this.uiTimer !== null) return;
    this.uiTimer = setTimeout(() => {
      this.uiTimer = null;
      void this.flushUiState();
    }, UI_STATE_FLUSH_INTERVAL_MS);
  }

  private flushMessages(): Promise<void> {
    if (this.messageTimer !== null) {
      clearTimeout(this.messageTimer);
      this.messageTimer = null;
    }
    if (this.pendingMessages.size === 0) return this.writeChain;

    const rows = Array.from(this.pendingMessages.values());
    this.pendingMessages.clear();
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => putChatMessages(rows))
      .catch((error) => {
        console.error('[ChatPersistence] Failed to persist chat messages:', error);
      });
    return this.writeChain;
  }

  private flushUiState(): Promise<void> {
    if (this.uiTimer !== null) {
      clearTimeout(this.uiTimer);
      this.uiTimer = null;
    }
    const state = this.pendingUiState;
    if (!state) return this.writeChain;

    this.pendingUiState = null;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => saveChatUiState(state))
      .catch((error) => {
        console.error('[ChatPersistence] Failed to persist chat UI state:', error);
      });
    return this.writeChain;
  }
}
