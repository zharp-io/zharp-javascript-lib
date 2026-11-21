/**
 * Zharp for React Native and Expo.
 *
 *     import { Zharp } from '@zharp/react-native';
 *     Zharp.init({ key: 'zpk_…', service: 'shop-app' });
 */
export { Zharp } from './instance';
export { ZharpReactNative, type ZharpSpan, type NavigationRef } from './client';
export { ZharpErrorBoundary, useZharpNavigation, type ZharpErrorBoundaryProps } from './react';
export type { ReactNativeOptions, Attributes, ZharpUser } from './types';
