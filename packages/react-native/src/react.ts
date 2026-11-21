/**
 * An error boundary for React Native: reports what a render throws, with the component stack,
 * and shows `fallback` instead of the tree that failed.
 *
 *     <ZharpErrorBoundary fallback={<Text>Something went wrong.</Text>}>
 *       <App />
 *     </ZharpErrorBoundary>
 */
import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import type { NavigationRef } from './client';
import { Zharp } from './instance';

/**
 * Screens from React Navigation or Expo Router, for as long as the component is mounted:
 *
 *     const ref = useNavigationContainerRef();   // from @react-navigation/native or expo-router
 *     useZharpNavigation(ref);
 */
export function useZharpNavigation(ref: NavigationRef | null | undefined): void {
  useEffect(() => Zharp.trackNavigation(ref), [ref]);
}

export interface ZharpErrorBoundaryProps {
  children?: ReactNode;
  /** What to show instead: an element, or a function of the error and a reset. */
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
    Zharp.reportReactError(error, info?.componentStack);
    this.props.onError?.(error, info?.componentStack);
  }

  resetError = (): void => {
    this.setState({ error: null, failed: false });
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children ?? null;
    const { fallback } = this.props;
    if (typeof fallback === 'function') return fallback({ error: this.state.error, resetError: this.resetError });
    return fallback ?? null;
  }
}
