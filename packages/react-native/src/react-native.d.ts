// The parts of React Native the SDK uses; the app brings react-native itself.
declare module 'react-native' {
  export const Platform: { OS: string; Version: string | number; constants?: Record<string, unknown> };
  export const NativeModules: Record<string, unknown>;
  export const AppState: {
    currentState: string;
    addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
  };
}
