package io.zharp.reactnative;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.Arguments;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import io.zharp.android.Zharp;
import io.zharp.android.ZharpOptions;

/**
 * ZharpNative: what @zharp/react-native's JavaScript asks of the device.
 *
 * - start: io.zharp.android underneath (native crashes, ANRs), with React Native's re-thrown JS
 *   error left to the JS side, so a JS crash is counted once.
 * - sessionId / setUser / clearUser / setTag: one session and one user for both sides.
 * - saveFatal / takeFatal: a fatal JS error written to disk before the app dies, and handed back
 *   on the next launch to be sent.
 *
 * Synchronous methods: they're called while the JS runtime is going down, or at start-up before
 * anything else is sent.
 */
public class ZharpModule extends ReactContextBaseJavaModule {
    /** React Native's native copy of a fatal JS error: the JS side reports the original. */
    private static final List<String> RN_RETHROWN = Arrays.asList(
            "com.facebook.react.common.JavascriptException",
            "com.facebook.react.bridge.JSApplicationCausedNativeException");

    public ZharpModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "ZharpNative";
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public String start(ReadableMap options) {
        try {
            if (Zharp.INSTANCE.isActive()) return Zharp.INSTANCE.getSessionId();
            ZharpOptions o = new ZharpOptions();
            o.setKey(string(options, "key"));
            o.setService(string(options, "service"));
            o.setEnvironment(string(options, "environment"));
            o.setRelease(string(options, "release"));
            o.setEndpoint(string(options, "endpoint"));
            o.setTracingOrigins(strings(options, "tracingOrigins"));
            if (options.hasKey("tracing")) o.setTracing(options.getBoolean("tracing"));
            if (options.hasKey("captureHeaders")) o.setCaptureHeaders(options.getBoolean("captureHeaders"));
            if (options.hasKey("debug")) o.setDebug(options.getBoolean("debug"));
            // The app's screens are JS routes, recorded from JS; logs are JS's to send when asked.
            o.setTrackScreens(false);
            o.setLogs(false);
            o.setIgnoreCrashTypes(RN_RETHROWN);
            Zharp.INSTANCE.init(getReactApplicationContext().getApplicationContext(), o);
            return Zharp.INSTANCE.getSessionId();
        } catch (Throwable error) {
            return null;
        }
    }

    @ReactMethod(isBlockingSynchronousMethod = true)
    public String sessionId() {
        try {
            return Zharp.INSTANCE.getSessionId();
        } catch (Throwable error) {
            return null;
        }
    }

    @ReactMethod
    public void setUser(String id, String email, String name) {
        try {
            Zharp.INSTANCE.setUser(id, email, name);
        } catch (Throwable ignored) {
        }
    }

    @ReactMethod
    public void clearUser() {
        try {
            Zharp.INSTANCE.clearUser();
        } catch (Throwable ignored) {
        }
    }

    @ReactMethod
    public void setTag(String key, String value) {
        try {
            Zharp.INSTANCE.setTag(key, value);
        } catch (Throwable ignored) {
        }
    }

    /** A fatal JS error's export body, on disk before the app dies. */
    @ReactMethod(isBlockingSynchronousMethod = true)
    public boolean saveFatal(String body) {
        try {
            File dir = pendingDir();
            File file = new File(dir, "fatal-" + System.currentTimeMillis() + "-" + System.nanoTime() + ".json");
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
                out.getFD().sync();
            }
            return true;
        } catch (Throwable error) {
            return false;
        }
    }

    /** Fatal JS errors saved by earlier runs, oldest first; each handed back once. */
    @ReactMethod(isBlockingSynchronousMethod = true)
    public WritableArray takeFatal() {
        WritableArray out = Arguments.createArray();
        try {
            File[] files = pendingDir().listFiles();
            if (files == null) return out;
            List<File> sorted = new ArrayList<>(Arrays.asList(files));
            Collections.sort(sorted, (a, b) -> a.getName().compareTo(b.getName()));
            for (File file : sorted) {
                try {
                    out.pushString(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
                } catch (Throwable ignored) {
                } finally {
                    //noinspection ResultOfMethodCallIgnored
                    file.delete();
                }
            }
        } catch (Throwable ignored) {
        }
        return out;
    }

    private File pendingDir() {
        File dir = new File(getReactApplicationContext().getFilesDir(), "zharp-react-native");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    private static String string(ReadableMap map, String key) {
        return map.hasKey(key) && !map.isNull(key) ? map.getString(key) : null;
    }

    private static List<String> strings(ReadableMap map, String key) {
        List<String> out = new ArrayList<>();
        if (!map.hasKey(key) || map.isNull(key)) return out;
        ReadableArray array = map.getArray(key);
        for (int i = 0; array != null && i < array.size(); i++) {
            String value = array.getString(i);
            if (value != null) out.add(value);
        }
        return out;
    }
}
