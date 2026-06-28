import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('[ErrorBoundary] React render error:', error);
    console.error('[ErrorBoundary] Component stack:', info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    // 尝试恢复：刷新页面
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="h-full w-full flex items-center justify-center bg-black">
          <div className="flex flex-col items-center gap-6 max-w-md text-center px-8">
            <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center">
              <span className="text-2xl">!</span>
            </div>
            <div>
              <h2 className="text-white text-lg font-semibold mb-2">界面渲染异常</h2>
              <p className="text-white/50 text-sm leading-relaxed">
                应用遇到了一个渲染错误，请尝试刷新页面恢复。
              </p>
              {this.state.error && (
                <pre className="mt-4 p-3 bg-white/5 rounded text-xs text-red-400/80 text-left overflow-auto max-h-32">
                  {this.state.error.message}
                </pre>
              )}
            </div>
            <button
              onClick={this.handleReset}
              className="px-6 py-2 bg-white/10 hover:bg-white/20 text-white rounded transition-colors text-sm"
            >
              刷新页面
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
