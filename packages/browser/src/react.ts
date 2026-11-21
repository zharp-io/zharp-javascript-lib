/**
 * @zharp/browser/react — an error boundary for React 16.8+ (and the way to get a component stack
 * on React 18). On React 19, Zharp.reactErrorHandler() in createRoot's options does the same for
 * the whole app with no component to add.
 *
 *     <ZharpErrorBoundary fallback={<p>Something went wrong.</p>}>
 *       <App />
 *     </ZharpErrorBoundary>
 */
import { Component, createElement, type ErrorInfo, type ReactNode } from 'react';
import type { ZharpBrowser } from './client';

/** The app's Zharp: the one instance @zharp/browser keeps on the page, whichever build loaded it. */
const zharp = (): ZharpBrowser | undefined => (globalThis as { __ZHARP_BROWSER__?: ZharpBrowser }).__ZHARP_BROWSER__;

export interface ZharpErrorBoundaryProps {
  children?: ReactNode;
  /** What to show instead of the tree that failed: an element, or a function of the error and a reset. */
  fallback?: ReactNode | ((props: { error: unknown; resetError: () => void }) => ReactNode);
  /** Called after the error is reported. */
  onError?: (error: unknown, componentStack: string | null | undefined) => void;
}

interface State {
  error: unknown;
  failed: boolean;
}

export class ZharpErrorBoundary extends Component<ZharpErrorBoundaryProps, State> {
  state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    zharp()?.reportReactError(error, info?.componentStack);
    this.props.onError?.(error, info?.componentStack);
  }

  resetError = (): void => {
    this.setState({ error: null, failed: false });
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children ?? null;
    const { fallback } = this.props;
    if (typeof fallback === 'function') return fallback({ error: this.state.error, resetError: this.resetError });
    return fallback ?? createElement('p', null, 'Something went wrong.');
  }
}
