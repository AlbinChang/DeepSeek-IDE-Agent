import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';

interface LazySyntaxHighlighterProps {
  language: string;
  children: string;
  className?: string;
  PreTag?: string;
  codeTagProps?: Record<string, unknown>;
  customStyle?: React.CSSProperties;
  deferUntilVisible?: boolean;
}

const HIGHLIGHT_CHAR_LIMIT = 40_000;

const deferredSyntaxTargets = new Map<Element, () => void>();
let deferredSyntaxObserver: IntersectionObserver | null = null;

function observeSyntaxTarget(target: Element, onVisible: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    return () => {};
  }

  if (!deferredSyntaxObserver) {
    deferredSyntaxObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;

        const reveal = deferredSyntaxTargets.get(entry.target);
        if (!reveal) continue;

        deferredSyntaxTargets.delete(entry.target);
        deferredSyntaxObserver?.unobserve(entry.target);
        reveal();
      }
    }, { rootMargin: '700px 0px' });
  }

  deferredSyntaxTargets.set(target, onVisible);
  deferredSyntaxObserver.observe(target);

  return () => {
    deferredSyntaxTargets.delete(target);
    deferredSyntaxObserver?.unobserve(target);
    if (deferredSyntaxTargets.size === 0) {
      deferredSyntaxObserver?.disconnect();
      deferredSyntaxObserver = null;
    }
  };
}

const buildCodePreview = (value: string) => {
  if (value.length <= HIGHLIGHT_CHAR_LIMIT) return value;
  return `${value.slice(0, HIGHLIGHT_CHAR_LIMIT)}\n\n[代码块过长，已跳过语法高亮并截断显示；原始字符数：${value.length.toLocaleString('zh-CN')}]`;
};

const SyntaxRuntime = lazy(async () => {
  const [syntaxModule, styleModule, javascript, typescript, jsx, tsx, python, java, bash, json, css, markup, markdown, sql, yaml, diff] = await Promise.all([
    import('react-syntax-highlighter/dist/esm/prism-light'),
    import('react-syntax-highlighter/dist/esm/styles/prism'),
    import('react-syntax-highlighter/dist/esm/languages/prism/javascript'),
    import('react-syntax-highlighter/dist/esm/languages/prism/typescript'),
    import('react-syntax-highlighter/dist/esm/languages/prism/jsx'),
    import('react-syntax-highlighter/dist/esm/languages/prism/tsx'),
    import('react-syntax-highlighter/dist/esm/languages/prism/python'),
    import('react-syntax-highlighter/dist/esm/languages/prism/java'),
    import('react-syntax-highlighter/dist/esm/languages/prism/bash'),
    import('react-syntax-highlighter/dist/esm/languages/prism/json'),
    import('react-syntax-highlighter/dist/esm/languages/prism/css'),
    import('react-syntax-highlighter/dist/esm/languages/prism/markup'),
    import('react-syntax-highlighter/dist/esm/languages/prism/markdown'),
    import('react-syntax-highlighter/dist/esm/languages/prism/sql'),
    import('react-syntax-highlighter/dist/esm/languages/prism/yaml'),
    import('react-syntax-highlighter/dist/esm/languages/prism/diff'),
  ]);
  const vscDarkPlus = (styleModule as any).vscDarkPlus;
  const SyntaxComponent = (syntaxModule as any).default || syntaxModule;

  [
    ['javascript', javascript], ['js', javascript],
    ['typescript', typescript], ['ts', typescript],
    ['jsx', jsx], ['tsx', tsx],
    ['python', python], ['py', python],
    ['java', java], ['bash', bash], ['shell', bash], ['sh', bash],
    ['json', json], ['css', css], ['html', markup], ['xml', markup],
    ['markdown', markdown], ['md', markdown],
    ['sql', sql], ['yaml', yaml], ['yml', yaml], ['diff', diff],
  ].forEach(([language, module]) => {
    SyntaxComponent.registerLanguage(language, (module as any).default || module);
  });

  return {
    default: ({ children, ...props }: LazySyntaxHighlighterProps) => (
      <SyntaxComponent style={vscDarkPlus} {...props}>
        {children}
      </SyntaxComponent>
    ),
  };
});

export const LazySyntaxHighlighter: React.FC<LazySyntaxHighlighterProps> = ({
  children,
  className,
  customStyle,
  deferUntilVisible = false,
  ...props
}) => {
  const code = String(children || '');
  const shouldDeferHighlight = deferUntilVisible && code.length <= HIGHLIGHT_CHAR_LIMIT;
  const [isNearViewport, setIsNearViewport] = useState(
    !deferUntilVisible || typeof IntersectionObserver === 'undefined'
  );
  const deferredCodeRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!shouldDeferHighlight || isNearViewport) return;
    const target = deferredCodeRef.current;
    if (!target) return;
    return observeSyntaxTarget(target, () => setIsNearViewport(true));
  }, [shouldDeferHighlight, isNearViewport]);

  if (code.length > HIGHLIGHT_CHAR_LIMIT) {
    return (
      <pre className={className} style={customStyle}>
        <code>{buildCodePreview(code)}</code>
      </pre>
    );
  }

  if (shouldDeferHighlight && !isNearViewport) {
    return (
      <pre ref={deferredCodeRef} className={className} style={customStyle}>
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <Suspense
      fallback={
        <pre className={className} style={customStyle}>
          <code>{code}</code>
        </pre>
      }
    >
      <SyntaxRuntime className={className} customStyle={customStyle} {...props}>
        {code}
      </SyntaxRuntime>
    </Suspense>
  );
};