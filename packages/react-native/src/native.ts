/**
 * ZharpNative, the package's native module (android/, ios/): absent in Expo Go and in a web or
 * test build, where the JS side runs on its own (JS errors only, its session in memory).
 */
import { NativeModules } from 'react-native';
import { safely } from '../../browser/src/util';

export interface ZharpNativeModule {
  /** Starts the native SDK (native crashes, ANRs); its session ID. */
  start(options: Record<string, unknown>): string | null;
  sessionId(): string | null;
  setUser(id: string | null, email: string | null, name: string | null): void;
  clearUser(): void;
  setTag(key: string, value: string | null): void;
  /** A fatal JS error's export body, on disk before the app dies. */
  saveFatal(body: string): boolean;
  /** Fatal JS errors saved by earlier runs, each handed back once. */
  takeFatal(): string[];
}

export function nativeModule(): ZharpNativeModule | null {
  return safely(() => {
    const module = (NativeModules as Record<string, unknown> | undefined)?.ZharpNative as ZharpNativeModule | undefined;
    return module && typeof module.start === 'function' ? module : null;
  }) ?? null;
}
