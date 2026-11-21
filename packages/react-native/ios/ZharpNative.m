// ZharpNative's methods, as React Native sees them (the module itself is ZharpNative.swift).
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ZharpNative, NSObject)

RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(start:(NSDictionary *)options)
RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(sessionId)
RCT_EXTERN_METHOD(setUser:(NSString *)id email:(NSString *)email name:(NSString *)name)
RCT_EXTERN_METHOD(clearUser)
RCT_EXTERN_METHOD(setTag:(NSString *)key value:(NSString *)value)
RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(saveFatal:(NSString *)body)
RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(takeFatal)

@end
