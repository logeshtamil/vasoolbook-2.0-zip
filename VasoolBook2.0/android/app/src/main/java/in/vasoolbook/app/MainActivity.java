package in.vasoolbook.app;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentUris;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Color;
import android.media.MediaScannerConnection;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.View;
import android.view.Window;
import androidx.activity.OnBackPressedCallback;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import org.json.JSONArray;
import org.json.JSONObject;
import java.security.MessageDigest;
import java.security.KeyStore;
import java.net.URLEncoder;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.ByteArrayOutputStream;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

public class MainActivity extends BridgeActivity {
    private static final int LOCAL_BACKUP_OPEN_REQUEST = 4207;
    private String pendingLocalBackupCallback = null;
    private String pendingCloudOAuthUrl = null;
    private final AtomicReference<String> activeDriveRestoreId = new AtomicReference<>(null);
    private final AtomicReference<String> activeLocalImportId = new AtomicReference<>(null);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applySystemBarTheme();

        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.setFitsSystemWindows(true);
            webView.getSettings().setJavaScriptEnabled(true);
            webView.getSettings().setDomStorageEnabled(true);
            webView.getSettings().setSupportMultipleWindows(true);
            webView.getSettings().setJavaScriptCanOpenWindowsAutomatically(true);

            CookieManager cookieManager = CookieManager.getInstance();
            cookieManager.setAcceptCookie(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                cookieManager.setAcceptThirdPartyCookies(webView, true);
            }

            webView.setWebChromeClient(new PopupSupportingWebChromeClient(getBridge()));
            webView.addJavascriptInterface(new AndroidDeveloperDiagnostics(), "VBAndroidDiagnostics");
            webView.addJavascriptInterface(new WhatsAppShareBridge(), "VBWhatsAppShare");
            webView.addJavascriptInterface(new LocalBackupBridge(), "VBLocalBackup");
            webView.addJavascriptInterface(new DriveRestoreBridge(), "VBDriveRestore");
            webView.addJavascriptInterface(new ExitBridge(), "VBExitBridge");
            webView.addJavascriptInterface(new AppSecurityBridge(), "VBAppSecurity");
            webView.addJavascriptInterface(new SecureStorageBridge(), "VBSecureStorage");
            webView.addJavascriptInterface(new CloudOAuthBridge(), "VBCloudOAuth");
            getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    webView.evaluateJavascript(
                        "(window.VBHandleAndroidBackButton && window.VBHandleAndroidBackButton()) || 'handled'",
                        value -> {
                            if (value != null && value.contains("exit")) {
                                finish();
                            }
                        }
                    );
                }
            });
            handleCloudOAuthIntent(getIntent());
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleCloudOAuthIntent(intent);
    }

    private void handleCloudOAuthIntent(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        if (data == null || !"vasoolbook".equalsIgnoreCase(data.getScheme()) || !"oauth".equalsIgnoreCase(data.getHost())) {
            return;
        }
        pendingCloudOAuthUrl = data.toString();
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) return;
        final String callbackUrl = pendingCloudOAuthUrl;
        final String js = "(function(){if(typeof window.vbHandleCloudOAuthCallback!=='function')return false;" +
            "window.vbHandleCloudOAuthCallback(" + JSONObject.quote(callbackUrl) + ");return true;})();";
        runOnUiThread(() -> webView.evaluateJavascript(js, value -> {
            if ("true".equals(value) && callbackUrl.equals(pendingCloudOAuthUrl)) pendingCloudOAuthUrl = null;
        }));
    }

    private void emitDriveRestoreEvent(String callbackName, JSONObject event) {
        if (callbackName == null || callbackName.trim().isEmpty()) return;
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) return;
        final String js = "(function(){var cb=window[" + JSONObject.quote(callbackName) + "];"
            + "if(typeof cb==='function')cb(" + JSONObject.quote(event.toString()) + ");})();";
        // A large import streams hundreds of these calls over many seconds; the
        // WebView/renderer can legitimately die mid-stream (backgrounded under
        // memory pressure, low-memory killer, activity recreated). Without this
        // try/catch, evaluateJavascript throwing on a destroyed WebView would be
        // an uncaught exception on the UI thread and crash the whole app process
        // with no chance for JS to ever show an error — swallow it instead so the
        // worst case is a stalled import the JS-side inactivity timeout catches.
        runOnUiThread(() -> {
            try {
                webView.evaluateJavascript(js, null);
            } catch (Throwable ignored) {}
        });
    }

    private class DriveRestoreBridge {
        private File restoreDir() throws Exception {
            File dir = new File(getCacheDir(), "drive-restore");
            if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("Could not create restore staging folder.");
            return dir;
        }

        @JavascriptInterface
        public String start(String fileId, String accessToken, long expectedSize, String callbackName) {
            JSONObject result = new JSONObject();
            try {
                if (fileId == null || fileId.trim().isEmpty()) throw new IllegalArgumentException("Missing Drive file ID.");
                if (accessToken == null || accessToken.trim().isEmpty()) throw new IllegalArgumentException("Missing Google access token.");
                if (callbackName == null || callbackName.trim().isEmpty()) throw new IllegalArgumentException("Missing restore callback.");
                String operationId = UUID.randomUUID().toString();
                if (!activeDriveRestoreId.compareAndSet(null, operationId)) throw new IllegalStateException("A native Drive restore is already running.");
                result.put("status", "started");
                result.put("operationId", operationId);
                new Thread(() -> streamDriveFile(operationId, fileId.trim(), accessToken.trim(), expectedSize, callbackName.trim()), "VBDriveRestore").start();
            } catch (Exception e) {
                try {
                    result.put("status", "error");
                    result.put("message", e.getClass().getSimpleName() + ": " + e.getMessage());
                } catch (Exception ignored) {}
            }
            return result.toString();
        }

        @JavascriptInterface
        public String cancel(String operationId) {
            JSONObject result = new JSONObject();
            boolean cancelled = operationId != null && activeDriveRestoreId.compareAndSet(operationId, null);
            try { result.put("status", cancelled ? "cancelled" : "not_running"); } catch (Exception ignored) {}
            return result.toString();
        }

        @JavascriptInterface
        public String cleanup() {
            JSONObject result = new JSONObject();
            int deleted = 0;
            try {
                File[] files = restoreDir().listFiles();
                if (files != null) for (File file : files) if (file.isFile() && file.delete()) deleted++;
                result.put("status", "cleaned");
                result.put("deleted", deleted);
            } catch (Exception e) {
                try { result.put("status", "error"); result.put("message", e.getMessage()); } catch (Exception ignored) {}
            }
            return result.toString();
        }

        private boolean isActive(String operationId) {
            return operationId.equals(activeDriveRestoreId.get());
        }

        private void streamDriveFile(String operationId, String fileId, String token, long expectedSize, String callbackName) {
            File temp = null;
            HttpURLConnection connection = null;
            AtomicBoolean terminalSent = new AtomicBoolean(false);
            try {
                temp = new File(restoreDir(), operationId + ".json.part");
                connection = (HttpURLConnection) new URL("https://www.googleapis.com/drive/v3/files/" + URLEncoder.encode(fileId, "UTF-8") + "?alt=media").openConnection();
                connection.setRequestMethod("GET");
                connection.setRequestProperty("Authorization", "Bearer " + token);
                connection.setConnectTimeout(30000);
                connection.setReadTimeout(60000);
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) throw new IllegalStateException("Drive download failed with HTTP " + status + ".");
                long responseSize = connection.getContentLengthLong();
                long total = expectedSize > 0 ? expectedSize : responseSize;
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long received = 0;
                byte[] buffer = new byte[128 * 1024];
                try (InputStream in = new BufferedInputStream(connection.getInputStream());
                     FileOutputStream fos = new FileOutputStream(temp, false);
                     OutputStream out = new BufferedOutputStream(fos)) {
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        if (!isActive(operationId)) throw new InterruptedException("Restore cancelled.");
                        out.write(buffer, 0, read);
                        digest.update(buffer, 0, read);
                        received += read;
                        JSONObject progress = new JSONObject();
                        progress.put("type", "progress");
                        progress.put("phase", "download");
                        progress.put("received", received);
                        progress.put("total", total);
                        emitDriveRestoreEvent(callbackName, progress);
                    }
                    out.flush();
                    fos.getFD().sync();
                }
                if (expectedSize > 0 && received != expectedSize) throw new IllegalStateException("Downloaded size mismatch: expected " + expectedSize + ", received " + received + ".");
                if (received <= 0) throw new IllegalStateException("Drive backup is empty.");

                int chunkIndex = 0;
                long delivered = 0;
                try (InputStream in = new BufferedInputStream(new FileInputStream(temp))) {
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        if (!isActive(operationId)) throw new InterruptedException("Restore cancelled.");
                        JSONObject chunk = new JSONObject();
                        chunk.put("type", "chunk");
                        chunk.put("index", chunkIndex++);
                        chunk.put("data", Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP));
                        emitDriveRestoreEvent(callbackName, chunk);
                        delivered += read;
                        JSONObject progress = new JSONObject();
                        progress.put("type", "progress");
                        progress.put("phase", "staging");
                        progress.put("received", delivered);
                        progress.put("total", received);
                        emitDriveRestoreEvent(callbackName, progress);
                    }
                }
                if (!isActive(operationId)) throw new InterruptedException("Restore cancelled.");
                JSONObject completed = new JSONObject();
                completed.put("type", "complete");
                completed.put("operationId", operationId);
                completed.put("size", received);
                completed.put("chunks", chunkIndex);
                completed.put("sha256", hexDigest(digest.digest()));
                terminalSent.set(true);
                emitDriveRestoreEvent(callbackName, completed);
            } catch (Exception e) {
                if (terminalSent.compareAndSet(false, true)) {
                    JSONObject error = new JSONObject();
                    try {
                        error.put("type", "error");
                        error.put("operationId", operationId);
                        error.put("message", e.getClass().getSimpleName() + ": " + e.getMessage());
                    } catch (Exception ignored) {}
                    emitDriveRestoreEvent(callbackName, error);
                }
            } finally {
                if (connection != null) connection.disconnect();
                if (temp != null && temp.exists()) temp.delete();
                activeDriveRestoreId.compareAndSet(operationId, null);
            }
        }

        private String hexDigest(byte[] bytes) {
            StringBuilder out = new StringBuilder(bytes.length * 2);
            for (byte value : bytes) out.append(String.format(Locale.US, "%02x", value & 0xff));
            return out.toString();
        }
    }

    private void applySystemBarTheme() {
        Window window = getWindow();
        if (window == null) return;
        int navy = Color.parseColor("#1B3A6B");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(true);
        }
        window.setStatusBarColor(navy);
        window.setNavigationBarColor(navy);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.setNavigationBarDividerColor(navy);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setNavigationBarContrastEnforced(false);
            window.setStatusBarContrastEnforced(false);
        }
        View decor = window.getDecorView();
        if (decor != null) {
            int flags = decor.getSystemUiVisibility();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
            decor.setSystemUiVisibility(flags);
        }
    }

    private class SecureStorageBridge {
        private static final String KEY_ALIAS = "vasoolbook_cloud_secure_v1";
        private static final String PREFS = "vb_secure_cloud";

        private void validateKey(String key) {
            if (key == null || !key.matches("[A-Za-z0-9._-]{1,128}")) {
                throw new IllegalArgumentException("Invalid secure-storage key.");
            }
        }

        private SecretKey getOrCreateKey() throws Exception {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            if (keyStore.containsAlias(KEY_ALIAS)) {
                KeyStore.SecretKeyEntry entry = (KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null);
                return entry.getSecretKey();
            }
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
             .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
             .setRandomizedEncryptionRequired(true)
             .build());
            return generator.generateKey();
        }

        private String encrypt(String value) throws Exception {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] encrypted = cipher.doFinal(String.valueOf(value == null ? "" : value).getBytes(StandardCharsets.UTF_8));
            return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" +
                Base64.encodeToString(encrypted, Base64.NO_WRAP);
        }

        private String decrypt(String value) throws Exception {
            String[] parts = String.valueOf(value == null ? "" : value).split(":", 2);
            if (parts.length != 2) throw new IllegalStateException("Secure value is invalid.");
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] encrypted = Base64.decode(parts[1], Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        }

        private String result(boolean ok, String value, String message) {
            JSONObject out = new JSONObject();
            try {
                out.put("status", ok ? "ok" : "error");
                if (value != null) out.put("value", value);
                if (message != null && !message.isEmpty()) out.put("message", message);
            } catch (Exception ignored) {}
            return out.toString();
        }

        @JavascriptInterface
        public synchronized String setItem(String key, String value) {
            try {
                validateKey(key);
                if (!getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(key, encrypt(value)).commit()) {
                    throw new IllegalStateException("Secure value could not be committed.");
                }
                return result(true, "", "");
            } catch (Exception error) {
                return result(false, "", error.getClass().getSimpleName() + ": " + error.getMessage());
            }
        }

        @JavascriptInterface
        public synchronized String getItem(String key) {
            try {
                validateKey(key);
                String encrypted = getSharedPreferences(PREFS, MODE_PRIVATE).getString(key, "");
                return result(true, encrypted.isEmpty() ? "" : decrypt(encrypted), "");
            } catch (Exception error) {
                return result(false, "", error.getClass().getSimpleName() + ": " + error.getMessage());
            }
        }

        @JavascriptInterface
        public synchronized String removeItem(String key) {
            try {
                validateKey(key);
                if (!getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(key).commit()) {
                    throw new IllegalStateException("Secure value could not be removed.");
                }
                return result(true, "", "");
            } catch (Exception error) {
                return result(false, "", error.getClass().getSimpleName() + ": " + error.getMessage());
            }
        }
    }

    private class CloudOAuthBridge {
        private String result(boolean ok, String url, String message) {
            JSONObject out = new JSONObject();
            try {
                out.put("status", ok ? "ok" : "error");
                out.put("url", url == null ? "" : url);
                if (message != null && !message.isEmpty()) out.put("message", message);
            } catch (Exception ignored) {}
            return out.toString();
        }

        @JavascriptInterface
        public String open(String url) {
            try {
                Uri uri = Uri.parse(url == null ? "" : url);
                if (!"https".equalsIgnoreCase(uri.getScheme())) {
                    throw new IllegalArgumentException("OAuth authorization URL must use HTTPS.");
                }
                runOnUiThread(() -> {
                    try {
                        Intent browser = new Intent(Intent.ACTION_VIEW, uri);
                        browser.addCategory(Intent.CATEGORY_BROWSABLE);
                        startActivity(browser);
                    } catch (Exception error) {
                        android.util.Log.e("VBCloudOAuth", "Could not open system browser", error);
                    }
                });
                return result(true, "", "");
            } catch (Exception error) {
                return result(false, "", error.getClass().getSimpleName() + ": " + error.getMessage());
            }
        }

        @JavascriptInterface
        public synchronized String consumeCallback() {
            String url = pendingCloudOAuthUrl;
            pendingCloudOAuthUrl = null;
            return result(true, url, "");
        }
    }

    private class ExitBridge {
        @JavascriptInterface
        public void exitApp() {
            runOnUiThread(() -> finish());
        }
    }

    private class AppSecurityBridge {
        @JavascriptInterface
        public String biometricStatus() {
            JSONObject result = new JSONObject();
            try {
                int flags = BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.BIOMETRIC_WEAK;
                int status = BiometricManager.from(MainActivity.this).canAuthenticate(flags);
                result.put("status", status == BiometricManager.BIOMETRIC_SUCCESS ? "available" : "unavailable");
                result.put("code", status);
                result.put("message", biometricStatusMessage(status));
            } catch (Exception e) {
                try {
                    result.put("status", "error");
                    result.put("code", -1);
                    result.put("message", e.getClass().getSimpleName() + ": " + e.getMessage());
                } catch (Exception ignored) {}
            }
            return result.toString();
        }

        @JavascriptInterface
        public String authenticate(String callbackName) {
            JSONObject start = new JSONObject();
            try {
                if (callbackName == null || !callbackName.matches("[A-Za-z_$][A-Za-z0-9_$]*")) {
                    throw new IllegalArgumentException("Invalid callback name.");
                }
                int flags = BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.BIOMETRIC_WEAK;
                int status = BiometricManager.from(MainActivity.this).canAuthenticate(flags);
                if (status != BiometricManager.BIOMETRIC_SUCCESS) {
                    emitSecurityCallback(callbackName, "unavailable", biometricStatusMessage(status), status);
                    start.put("status", "unavailable");
                    start.put("message", biometricStatusMessage(status));
                    return start.toString();
                }
                runOnUiThread(() -> {
                    Executor executor = ContextCompat.getMainExecutor(MainActivity.this);
                    BiometricPrompt prompt = new BiometricPrompt(MainActivity.this, executor, new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                            emitSecurityCallback(callbackName, "success", "Biometric verified.", 0);
                        }

                        @Override
                        public void onAuthenticationError(int errorCode, CharSequence errString) {
                            emitSecurityCallback(callbackName, "error", String.valueOf(errString), errorCode);
                        }

                        @Override
                        public void onAuthenticationFailed() {
                            emitSecurityCallback(callbackName, "failed", "Biometric did not match.", -2);
                        }
                    });
                    BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                        .setTitle("Unlock Vasool Book")
                        .setSubtitle("Use fingerprint or screen lock")
                        .setNegativeButtonText("Use PIN")
                        .setAllowedAuthenticators(flags)
                        .build();
                    prompt.authenticate(info);
                });
                start.put("status", "started");
            } catch (Exception e) {
                try {
                    start.put("status", "error");
                    start.put("message", e.getClass().getSimpleName() + ": " + e.getMessage());
                } catch (Exception ignored) {}
            }
            return start.toString();
        }

        private String biometricStatusMessage(int status) {
            switch (status) {
                case BiometricManager.BIOMETRIC_SUCCESS: return "Biometric available.";
                case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE: return "No biometric hardware.";
                case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE: return "Biometric hardware unavailable.";
                case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED: return "No fingerprint/biometric enrolled.";
                case BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED: return "Security update required.";
                case BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED: return "Biometric unsupported.";
                case BiometricManager.BIOMETRIC_STATUS_UNKNOWN: return "Biometric status unknown.";
                default: return "Biometric unavailable: " + status;
            }
        }

        private void emitSecurityCallback(String callbackName, String status, String message, int code) {
            try {
                JSONObject payload = new JSONObject();
                payload.put("status", status);
                payload.put("message", message == null ? "" : message);
                payload.put("code", code);
                String js = "window." + callbackName + " && window." + callbackName + "(" + JSONObject.quote(payload.toString()) + ")";
                runOnUiThread(() -> {
                    WebView webView = getBridge().getWebView();
                    if (webView != null) webView.evaluateJavascript(js, null);
                });
            } catch (Exception ignored) {}
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == LOCAL_BACKUP_OPEN_REQUEST) {
            handleLocalBackupOpenResult(resultCode, data);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    // No fixed MB/GB cap: a backup of any size the device's storage holds may be
    // imported. Memory safety comes from streaming the read in bounded chunks
    // (below) and delivering each chunk to JS as its own small callback instead
    // of ever building one JSON string containing the whole file — the same
    // approach already proven for large Google Drive restores. A device that
    // genuinely runs out of memory or storage still fails, but with a clear,
    // specific message (OutOfMemoryError / storage errors are caught below),
    // never a blind "file too large" rejection based on size alone.
    private static final int LOCAL_IMPORT_CHUNK_BYTES = 128 * 1024;

    private void handleLocalBackupOpenResult(int resultCode, Intent data) {
        final String callbackName = pendingLocalBackupCallback;
        pendingLocalBackupCallback = null;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            JSONObject result = new JSONObject();
            try {
                result.put("type", "cancelled");
                result.put("message", "Backup import cancelled.");
            } catch (Exception ignored) {}
            emitDriveRestoreEvent(callbackName, result);
            return;
        }
        final Uri uri = data.getData();
        if ((data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0) {
            try {
                getContentResolver().takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                );
            } catch (Exception ignored) {}
        }
        final String operationId = UUID.randomUUID().toString();
        if (!activeLocalImportId.compareAndSet(null, operationId)) {
            JSONObject result = new JSONObject();
            try {
                result.put("type", "error");
                result.put("message", "A local backup import is already running.");
            } catch (Exception ignored) {}
            emitDriveRestoreEvent(callbackName, result);
            return;
        }
        // Read off the UI thread: a large backup must never block the UI thread
        // (Android's ANR watchdog would kill the app), and a Throwable catch is
        // required here — OutOfMemoryError is an Error, not an Exception, and an
        // uncaught Error on this path crashes the whole process with no chance
        // for the JS layer to show an error message.
        new Thread(() -> streamLocalImportFile(operationId, uri, callbackName), "vb-local-backup-import").start();
    }

    private boolean isLocalImportActive(String operationId) {
        return operationId.equals(activeLocalImportId.get());
    }

    private void streamLocalImportFile(String operationId, Uri uri, String callbackName) {
        AtomicBoolean terminalSent = new AtomicBoolean(false);
        try {
            String filename = displayNameForUri(uri, "vasoolbook_backup.json");
            String path = displayPathForUri(uri, filename);
            long declaredSize = queryUriSize(uri); // -1 if unknown; progress falls back to bytes-read-only display
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[LOCAL_IMPORT_CHUNK_BYTES];
            long received = 0;
            int chunkIndex = 0;
            try (InputStream in = new BufferedInputStream(getContentResolver().openInputStream(uri))) {
                if (in == null) throw new IllegalStateException("Could not open selected backup file.");
                int read;
                while ((read = in.read(buffer)) != -1) {
                    if (!isLocalImportActive(operationId)) throw new InterruptedException("Import cancelled.");
                    digest.update(buffer, 0, read);
                    JSONObject chunk = new JSONObject();
                    chunk.put("type", "chunk");
                    chunk.put("index", chunkIndex++);
                    chunk.put("data", Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP));
                    emitDriveRestoreEvent(callbackName, chunk);
                    received += read;
                    JSONObject progress = new JSONObject();
                    progress.put("type", "progress");
                    progress.put("phase", "reading");
                    progress.put("received", received);
                    progress.put("total", declaredSize > 0 ? declaredSize : received);
                    emitDriveRestoreEvent(callbackName, progress);
                }
            }
            if (received <= 0) throw new IllegalStateException("Selected backup file is empty.");
            if (!isLocalImportActive(operationId)) throw new InterruptedException("Import cancelled.");
            JSONObject completed = new JSONObject();
            completed.put("type", "complete");
            completed.put("operationId", operationId);
            completed.put("filename", filename);
            completed.put("path", path);
            completed.put("size", received);
            completed.put("chunks", chunkIndex);
            completed.put("sha256", hexDigestLocal(digest.digest()));
            terminalSent.set(true);
            emitDriveRestoreEvent(callbackName, completed);
        } catch (Throwable t) {
            if (terminalSent.compareAndSet(false, true)) {
                JSONObject error = new JSONObject();
                try {
                    boolean cancelled = t instanceof InterruptedException;
                    error.put("type", cancelled ? "cancelled" : "error");
                    error.put("code", t instanceof OutOfMemoryError ? "out_of_memory" : (isStorageFullTopLevel(t) ? "storage_full" : "read_failed"));
                    error.put("message", cancelled ? "Backup import cancelled." : describeThrowable(t));
                } catch (Exception ignored) {}
                emitDriveRestoreEvent(callbackName, error);
            }
        } finally {
            activeLocalImportId.compareAndSet(operationId, null);
        }
    }

    private String hexDigestLocal(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) out.append(String.format(Locale.US, "%02x", value & 0xff));
        return out.toString();
    }

    private boolean isStorageFullTopLevel(Throwable e) {
        while (e != null) {
            String msg = e.getMessage() == null ? "" : e.getMessage().toLowerCase(Locale.US);
            if (msg.contains("enospc") || msg.contains("no space") || msg.contains("not enough space") || msg.contains("storage is full")) {
                return true;
            }
            e = e.getCause();
        }
        return false;
    }

    private String describeThrowable(Throwable t) {
        String cls = t.getClass().getSimpleName();
        String msg = t.getMessage();
        return msg == null || msg.trim().isEmpty() ? cls : cls + ": " + msg;
    }

    private long queryUriSize(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (idx >= 0 && !cursor.isNull(idx)) return cursor.getLong(idx);
            }
        } catch (Exception ignored) {}
        return -1; // unknown size — callers fall back to a bytes-read-only progress display
    }

    private void emitLocalBackupCallback(JSONObject result) {
        final String callbackName = pendingLocalBackupCallback;
        pendingLocalBackupCallback = null;
        if (callbackName == null || callbackName.trim().isEmpty()) return;
        try {
            WebView webView = getBridge() == null ? null : getBridge().getWebView();
            if (webView == null) return;
            final String js = "(function(){var cb=window[" + JSONObject.quote(callbackName) + "];"
                + "if(typeof cb==='function')cb(" + JSONObject.quote(result.toString()) + ");})();";
            runOnUiThread(() -> {
                try { webView.evaluateJavascript(js, null); } catch (Exception ignored) {}
            });
        } catch (Throwable ignored) {}
    }

    private String readTextFromUri(Uri uri, long maxBytes) throws Exception {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IllegalStateException("Could not open selected backup file.");
            ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
            byte[] buffer = new byte[64 * 1024];
            long total = 0;
            int read;
            while ((read = in.read(buffer)) != -1) {
                total += read;
                if (total > maxBytes) {
                    throw new IllegalStateException("Backup file is too large to import safely (limit "
                        + (maxBytes / (1024 * 1024)) + " MB).");
                }
                out.write(buffer, 0, read);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private String displayNameForUri(Uri uri, String fallback) {
        String name = null;
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) name = cursor.getString(idx);
            }
        } catch (Exception ignored) {}
        if (name == null || name.trim().isEmpty()) name = fallback;
        return name;
    }

    private String displayPathForUri(Uri uri, String filename) {
        String text = uri == null ? "" : uri.toString();
        if (text.contains("downloads") || text.contains("Downloads")) {
            return "Downloads/VasoolBook/" + filename;
        }
        return filename;
    }

    private JSONObject backupFileInfo(String filename, String path, Uri uri, long modified, long size) throws Exception {
        JSONObject file = new JSONObject();
        file.put("filename", filename);
        file.put("path", path);
        file.put("uri", uri == null ? "" : uri.toString());
        file.put("modified", modified);
        file.put("size", size);
        return file;
    }

    private class LocalBackupBridge {
        private String sha256Hex(byte[] bytes) throws Exception {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes);
            StringBuilder out = new StringBuilder(digest.length * 2);
            for (byte value : digest) out.append(String.format(Locale.US, "%02x", value & 0xff));
            return out.toString();
        }

        private File emergencyBackupDir() throws Exception {
            File dir = new File(getFilesDir(), "drive-emergency");
            if (!dir.exists() && !dir.mkdirs()) {
                throw new IllegalStateException("Could not create emergency backup folder.");
            }
            return dir;
        }

        private String sanitizeEmergencyFilename(String filename) {
            String name = filename == null ? "" : filename.trim();
            name = name.replaceAll("[^A-Za-z0-9_.-]", "_");
            if (!name.startsWith("Emergency_Backup_") || !name.endsWith(".db")) {
                throw new IllegalArgumentException("Invalid emergency backup filename.");
            }
            return name;
        }

        @JavascriptInterface
        public String saveEmergencyDb(String filename, String json) {
            JSONObject result = new JSONObject();
            File temp = null;
            try {
                if (json == null || json.trim().isEmpty()) {
                    throw new IllegalArgumentException("Emergency backup is empty.");
                }
                String safeName = sanitizeEmergencyFilename(filename);
                byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
                File dir = emergencyBackupDir();
                long usable = dir.getUsableSpace();
                if (usable > 0 && bytes.length + (1024 * 1024L) > usable) {
                    throw new IllegalStateException("Device storage is full. Emergency backup was not created.");
                }
                File target = new File(dir, safeName);
                temp = new File(dir, safeName + ".tmp");
                try (FileOutputStream out = new FileOutputStream(temp, false)) {
                    out.write(bytes);
                    out.flush();
                    out.getFD().sync();
                }
                if (target.exists() && !target.delete()) {
                    throw new IllegalStateException("Could not replace the emergency backup.");
                }
                if (!temp.renameTo(target)) {
                    try (InputStream in = new FileInputStream(temp);
                         FileOutputStream out = new FileOutputStream(target, false)) {
                        byte[] buffer = new byte[8192];
                        int read;
                        while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
                        out.flush();
                        out.getFD().sync();
                    }
                    if (!temp.delete()) temp.deleteOnExit();
                }
                result.put("status", "saved");
                result.put("filename", safeName);
                result.put("path", target.getAbsolutePath());
                result.put("size", target.length());
            } catch (Exception e) {
                if (temp != null && temp.exists()) temp.delete();
                try {
                    result.put("status", "error");
                    result.put("code", isStorageFull(e) ? "storage_full" : "emergency_save_failed");
                    result.put("message", e.getClass().getSimpleName() + ": " + e.getMessage());
                } catch (Exception ignored) {}
            }
            return result.toString();
        }

        @JavascriptInterface
        public String deleteEmergencyDb(String filename) {
            JSONObject result = new JSONObject();
            try {
                String safeName = sanitizeEmergencyFilename(filename);
                File dir = emergencyBackupDir();
                File target = new File(dir, safeName);
                String dirPath = dir.getCanonicalPath() + File.separator;
                if (!target.getCanonicalPath().startsWith(dirPath)) {
                    throw new SecurityException("Emergency backup path rejected.");
                }
                boolean deleted = !target.exists() || target.delete();
                result.put("status", deleted ? "deleted" : "error");
                result.put("filename", safeName);
                if (!deleted) result.put("message", "Emergency backup could not be deleted.");
            } catch (Exception e) {
                try {
                    result.put("status", "error");
                    result.put("message", e.getClass().getSimpleName() + ": " + e.getMessage());
                } catch (Exception ignored) {}
            }
            return result.toString();
        }

        @JavascriptInterface
        public String saveJson(String filename, String json) {
            JSONObject result = new JSONObject();
            String safeName = sanitizeBackupFilename(filename);
            Uri pendingUri = null;
            File legacyTarget = null;
            try {
                if (json == null || json.trim().isEmpty()) {
                    throw new IllegalArgumentException("Backup JSON is empty.");
                }
                byte[] bytes = json.getBytes("UTF-8");
                long usable = Environment.getExternalStorageDirectory().getUsableSpace();
                if (usable > 0 && bytes.length + (1024 * 1024) > usable) {
                    throw new IllegalStateException("Device storage is full. Need " + bytes.length + " bytes for backup, available " + usable + " bytes.");
                }
                String displayPath;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentResolver resolver = getContentResolver();
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                    values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/VasoolBook");
                    values.put(MediaStore.Downloads.IS_PENDING, 1);
                    pendingUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (pendingUri == null) throw new IllegalStateException("Could not create Downloads file.");
                    try (OutputStream out = resolver.openOutputStream(pendingUri, "w")) {
                        if (out == null) throw new IllegalStateException("Could not open Downloads file.");
                        out.write(bytes);
                        out.flush();
                    }
                    values.clear();
                    values.put(MediaStore.Downloads.IS_PENDING, 0);
                    resolver.update(pendingUri, values, null, null);
                    safeName = displayNameForUri(pendingUri, safeName);
                    displayPath = "Downloads/VasoolBook/" + safeName;
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "VasoolBook");
                    if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("Could not create " + dir.getAbsolutePath());
                    legacyTarget = new File(dir, safeName);
                    try (OutputStream out = new FileOutputStream(legacyTarget, false)) {
                        out.write(bytes);
                        out.flush();
                    }
                    displayPath = legacyTarget.getAbsolutePath();
                }
                String expectedSha256 = sha256Hex(bytes);
                MessageDigest actualDigest = MessageDigest.getInstance("SHA-256");
                long verifiedSize = 0;
                InputStream verifyStream = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? getContentResolver().openInputStream(pendingUri)
                    : new FileInputStream(legacyTarget);
                if (verifyStream == null) throw new IllegalStateException("Could not verify the saved Downloads file.");
                try (InputStream in = new BufferedInputStream(verifyStream)) {
                    byte[] verifyBuffer = new byte[128 * 1024];
                    int read;
                    while ((read = in.read(verifyBuffer)) != -1) {
                        actualDigest.update(verifyBuffer, 0, read);
                        verifiedSize += read;
                    }
                }
                byte[] actualDigestBytes = actualDigest.digest();
                StringBuilder actualHex = new StringBuilder(actualDigestBytes.length * 2);
                for (byte value : actualDigestBytes) actualHex.append(String.format(Locale.US, "%02x", value & 0xff));
                String actualSha256 = actualHex.toString();
                if (verifiedSize != bytes.length || !expectedSha256.equalsIgnoreCase(actualSha256)) {
                    throw new IllegalStateException("Saved backup verification failed: size " + bytes.length + "->" + verifiedSize
                        + ", sha256 " + expectedSha256 + "->" + actualSha256 + ".");
                }
                result.put("status", "saved");
                result.put("path", displayPath);
                result.put("filename", safeName);
                result.put("size", verifiedSize);
                result.put("sha256", actualSha256);
                result.put("verified", true);
            } catch (Exception e) {
                if (pendingUri != null) {
                    try { getContentResolver().delete(pendingUri, null, null); } catch (Exception ignored) {}
                }
                if (legacyTarget != null && legacyTarget.exists()) {
                    try { legacyTarget.delete(); } catch (Exception ignored) {}
                }
                try {
                    result.put("status", "error");
                    result.put("code", isStorageFull(e) ? "storage_full" : "save_failed");
                    result.put("message", e.getClass().getSimpleName() + ": " + e.getMessage());
                } catch (Exception ignored) {}
            }
            return result.toString();
        }

        @JavascriptInterface
        public String openJsonBackup(String callbackName) {
            JSONObject result = new JSONObject();
            try {
                if (pendingLocalBackupCallback != null) {
                    throw new IllegalStateException("A backup import picker is already open.");
                }
                if (callbackName == null || callbackName.trim().isEmpty()) {
                    throw new IllegalArgumentException("Missing JS callback name.");
                }
                pendingLocalBackupCallback = callbackName.trim();
                runOnUiThread(() -> {
                    try {
                        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType("application/json");
                        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                            "application/json",
                            "text/json",
                            "text/plain",
                            "application/octet-stream"
                        });
                        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                        startActivityForResult(Intent.createChooser(intent, "Select VasoolBook backup"), LOCAL_BACKUP_OPEN_REQUEST);
                    } catch (Exception e) {
                        JSONObject error = new JSONObject();
                        try {
                            error.put("status", "error");
                            error.put("code", "picker_failed");
                            error.put("message", e.getClass().getSimpleName() + ": " + e.getMessage());
                        } catch (Exception ignored) {}
                        emitLocalBackupCallback(error);
                    }
                });
                result.put("status", "opening");
            } catch (Exception e) {
                try {
                    result.put("status", "error");
                    result.put("code", "open_failed");
                    result.put("message", e.getClass().getSimpleName() + ": " + e.getMessage());
                } catch (Exception ignored) {}
            }
            return result.toString();
        }

        @JavascriptInterface
        public String cancelImport(String operationId) {
            JSONObject result = new JSONObject();
            boolean cancelled = operationId != null && activeLocalImportId.compareAndSet(operationId, null);
            try { result.put("status", cancelled ? "cancelled" : "not_running"); } catch (Exception ignored) {}
            return result.toString();
        }

        @JavascriptInterface
        public String listJsonBackups() {
            JSONObject result = new JSONObject();
            JSONArray files = new JSONArray();
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentResolver resolver = getContentResolver();
                    Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
                    String[] projection = new String[]{
                        MediaStore.Downloads._ID,
                        MediaStore.Downloads.DISPLAY_NAME,
                        MediaStore.Downloads.RELATIVE_PATH,
                        MediaStore.Downloads.DATE_MODIFIED,
                        MediaStore.Downloads.SIZE
                    };
                    String selection = MediaStore.Downloads.RELATIVE_PATH + " LIKE ? AND " + MediaStore.Downloads.DISPLAY_NAME + " LIKE ?";
                    String[] args = new String[]{"%VasoolBook%", "%.json"};
                    try (Cursor cursor = resolver.query(collection, projection, selection, args, MediaStore.Downloads.DATE_MODIFIED + " DESC")) {
                        if (cursor != null) {
                            int idCol = cursor.getColumnIndexOrThrow(MediaStore.Downloads._ID);
                            int nameCol = cursor.getColumnIndexOrThrow(MediaStore.Downloads.DISPLAY_NAME);
                            int modifiedCol = cursor.getColumnIndexOrThrow(MediaStore.Downloads.DATE_MODIFIED);
                            int sizeCol = cursor.getColumnIndexOrThrow(MediaStore.Downloads.SIZE);
                            while (cursor.moveToNext()) {
                                long id = cursor.getLong(idCol);
                                String name = cursor.getString(nameCol);
                                if (name == null || !name.toLowerCase(Locale.US).endsWith(".json")) continue;
                                Uri uri = ContentUris.withAppendedId(collection, id);
                                long modified = cursor.getLong(modifiedCol);
                                long size = cursor.getLong(sizeCol);
                                files.put(backupFileInfo(name, "Downloads/VasoolBook/" + name, uri, modified, size));
                            }
                        }
                    }
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "VasoolBook");
                    File[] found = dir.listFiles((file) -> file.isFile() && file.getName().toLowerCase(Locale.US).endsWith(".json"));
                    if (found != null) {
                        for (File file : found) {
                            files.put(backupFileInfo(file.getName(), file.getAbsolutePath(), Uri.fromFile(file), file.lastModified() / 1000L, file.length()));
                        }
                    }
                }
                result.put("status", "ok");
                result.put("folder", "Downloads/VasoolBook");
                result.put("files", files);
            } catch (Exception e) {
                try {
                    result.put("status", "error");
                    result.put("code", "list_failed");
                    result.put("message", e.getClass().getSimpleName() + ": " + e.getMessage());
                } catch (Exception ignored) {}
            }
            return result.toString();
        }

        @JavascriptInterface
        public String readJsonBackup(String uriText, String filename) {
            JSONObject result = new JSONObject();
            try {
                if (uriText == null || uriText.trim().isEmpty()) {
                    throw new IllegalArgumentException("Missing backup file URI.");
                }
                Uri uri = Uri.parse(uriText);
                String safeName = filename == null || filename.trim().isEmpty()
                    ? displayNameForUri(uri, "vasoolbook_backup.json")
                    : filename.trim();
                // No fixed MB/GB cap — see streamLocalImportFile() for the actual
                // (chunked, memory-safe) import path this app uses; this method is
                // not currently called from JS but is kept consistent with that policy.
                String json = readTextFromUri(uri, Long.MAX_VALUE);
                if (json == null || json.trim().isEmpty()) {
                    throw new IllegalStateException("Selected backup file is empty.");
                }
                result.put("status", "selected");
                result.put("filename", safeName);
                result.put("path", displayPathForUri(uri, safeName));
                result.put("json", json);
            } catch (Throwable t) {
                try {
                    result.put("status", "error");
                    result.put("code", t instanceof OutOfMemoryError ? "out_of_memory" : "read_failed");
                    result.put("message", describeThrowable(t));
                } catch (Exception ignored) {}
            }
            return result.toString();
        }

        private boolean isStorageFull(Throwable e) {
            while (e != null) {
                String msg = e.getMessage() == null ? "" : e.getMessage().toLowerCase(Locale.US);
                if (msg.contains("enospc") || msg.contains("no space") || msg.contains("not enough space") || msg.contains("storage is full")) {
                    return true;
                }
                e = e.getCause();
            }
            return false;
        }

        private String sanitizeBackupFilename(String filename) {
            String fallback = "vasoolbook_backup.json";
            String name = filename == null ? fallback : filename.trim();
            name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            if (!name.toLowerCase(Locale.US).endsWith(".json")) name += ".json";
            if (!name.startsWith("vasoolbook_backup_")) {
                name = "vasoolbook_backup_" + name;
            }
            return name;
        }
    }

    private class WhatsAppShareBridge {
        private static final String PREFS = "vb_whatsapp_share";

        @JavascriptInterface
        public String share(String phone, String message, String preferredPath) {
            String path = "wa2".equals(preferredPath) ? "wa2" : "wa1";
            try {
                List<WaCandidate> candidates = resolveWhatsAppCandidates(phone, message);
                if (candidates.isEmpty()) {
                    return waResult("not_installed", "", "", path, "No WhatsApp app can handle whatsapp://send, wa.me, or ACTION_SEND.");
                }

                WaCandidate selected = chooseCandidate(candidates, path);
                WaCandidate fallback = chooseCandidate(candidates, "wa2".equals(path) ? "wa1" : "wa2");
                if (fallback != null && selected != null && fallback.sameComponent(selected)) {
                    fallback = firstDifferent(candidates, selected);
                }

                String openedError = tryOpen(selected, phone, message);
                if (openedError == null) {
                    saveCandidate(path, selected);
                    return waResult("opened", selected.packageName, selected.label, path, "");
                }

                if (fallback != null) {
                    String fallbackError = tryOpen(fallback, phone, message);
                    if (fallbackError == null) {
                        saveCandidate("wa2".equals(path) ? "wa1" : "wa2", fallback);
                        return waResult("fallback_opened", fallback.packageName, fallback.label, path, openedError);
                    }
                    return waResult("error", selected.packageName, selected.label, path, openedError + " | fallback: " + fallbackError);
                }
                return waResult("error", selected.packageName, selected.label, path, openedError);
            } catch (Exception e) {
                return waResult("error", "", "", path, e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }

        @JavascriptInterface
        public String shareImage(String dataUrl, String mimeType, String filename, String phone, String message, String preferredPath) {
            String path = "wa2".equals(preferredPath) ? "wa2" : "wa1";
            try {
                Uri uri = writeReceiptCacheImage(dataUrl, mimeType, filename);
                List<WaCandidate> candidates = resolveImageShareCandidates(uri, mimeType, message);
                if (candidates.isEmpty()) {
                    return waResult("not_installed", "", "", path, "No WhatsApp app can handle receipt image sharing.");
                }
                WaCandidate selected = chooseCandidate(candidates, path);
                WaCandidate fallback = chooseCandidate(candidates, "wa2".equals(path) ? "wa1" : "wa2");
                if (fallback != null && selected != null && fallback.sameComponent(selected)) {
                    fallback = firstDifferent(candidates, selected);
                }
                String openedError = tryOpenImage(selected, uri, mimeType, message);
                if (openedError == null) {
                    saveCandidate(path, selected);
                    return waResult("opened", selected.packageName, selected.label, path, "");
                }
                if (fallback != null) {
                    String fallbackError = tryOpenImage(fallback, uri, mimeType, message);
                    if (fallbackError == null) {
                        saveCandidate("wa2".equals(path) ? "wa1" : "wa2", fallback);
                        return waResult("fallback_opened", fallback.packageName, fallback.label, path, openedError);
                    }
                    return waResult("error", selected.packageName, selected.label, path, openedError + " | fallback: " + fallbackError);
                }
                return waResult("error", selected.packageName, selected.label, path, openedError);
            } catch (Exception e) {
                return waResult("error", "", "", path, e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }

        @JavascriptInterface
        public String shareReceipt(String text, String phone, String imageBase64, String mimeType, String fileName) {
            try {
                Uri uri = writeReceiptCacheImage(imageBase64, mimeType, fileName);
                String shareText = text == null ? "" : text;
                String error = openGeneralImageShareSheet(uri, safeImageMime(mimeType), shareText);
                if (error != null) return waResult("error", "", "", "", error);
                JSONObject result = new JSONObject();
                result.put("status", "opened");
                result.put("target", "share_sheet");
                result.put("filename", sanitizeImageFileName(fileName, mimeType));
                return result.toString();
            } catch (Exception e) {
                return waResult("error", "", "", "", e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }

        @JavascriptInterface
        public String saveImage(String dataUrl, String mimeType, String filename) {
            try {
                String cleanName = sanitizeImageFileName(filename, mimeType);
                byte[] bytes = decodeDataUrl(dataUrl);
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                    File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    File directory = new File(downloads, "VasoolBook");
                    if (!directory.exists() && !directory.mkdirs()) {
                        throw new IllegalStateException("Could not create Downloads/VasoolBook.");
                    }
                    File destination = new File(directory, cleanName);
                    File temporary = new File(directory, cleanName + ".tmp");
                    try (FileOutputStream out = new FileOutputStream(temporary, false)) {
                        out.write(bytes);
                        out.flush();
                        out.getFD().sync();
                    }
                    if (destination.exists() && !destination.delete()) {
                        temporary.delete();
                        throw new IllegalStateException("Could not replace existing receipt image.");
                    }
                    if (!temporary.renameTo(destination)) {
                        temporary.delete();
                        throw new IllegalStateException("Could not finalize receipt image.");
                    }
                    MediaScannerConnection.scanFile(
                        MainActivity.this,
                        new String[]{destination.getAbsolutePath()},
                        new String[]{safeImageMime(mimeType)},
                        null
                    );
                    JSONObject result = new JSONObject();
                    result.put("status", "saved");
                    result.put("filename", cleanName);
                    result.put("path", destination.getAbsolutePath());
                    result.put("uri", Uri.fromFile(destination).toString());
                    return result.toString();
                }

                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, cleanName);
                values.put(MediaStore.MediaColumns.MIME_TYPE, safeImageMime(mimeType));
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + File.separator + "VasoolBook");
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                ContentResolver resolver = getContentResolver();
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IllegalStateException("Could not create Downloads file.");
                try (OutputStream out = resolver.openOutputStream(uri, "w")) {
                    if (out == null) throw new IllegalStateException("Could not open output stream.");
                    out.write(bytes);
                    out.flush();
                }
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(uri, done, null, null);
                JSONObject result = new JSONObject();
                result.put("status", "saved");
                result.put("filename", cleanName);
                result.put("path", "Downloads/VasoolBook/" + cleanName);
                result.put("uri", uri.toString());
                return result.toString();
            } catch (Exception e) {
                return waResult("error", "", "", "", e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }

        @JavascriptInterface
        public String dial(String phone, boolean directCall) {
            try {
                String clean = cleanDialPhone(phone);
                if (clean.length() < 7) {
                    return waResult("invalid_number", "", "", "", "Missing or invalid phone number.");
                }
                if (directCall) {
                    return waResult("permission_required", "", "", "", "Direct ACTION_CALL is disabled. Use the Android dialer to confirm the call.");
                }
                String error = openDialer(clean);
                if (error != null) return waResult("error", "", "", "", error);
                JSONObject result = new JSONObject();
                result.put("status", "opened");
                result.put("phone", clean);
                result.put("action", "ACTION_DIAL");
                return result.toString();
            } catch (Exception e) {
                return waResult("error", "", "", "", e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }

        private List<WaCandidate> resolveWhatsAppCandidates(String phone, String message) {
            List<WaCandidate> out = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            PackageManager pm = getPackageManager();
            Intent[] probes = new Intent[] {
                buildViewIntent("whatsapp", phone, message),
                buildViewIntent("wa.me", phone, message),
                buildSendIntent(message)
            };
            for (Intent probe : probes) {
                List<ResolveInfo> resolved = pm.queryIntentActivities(probe, PackageManager.MATCH_DEFAULT_ONLY);
                for (ResolveInfo info : resolved) {
                    if (info == null || info.activityInfo == null) continue;
                    String pkg = info.activityInfo.packageName == null ? "" : info.activityInfo.packageName;
                    String cls = info.activityInfo.name == null ? "" : info.activityInfo.name;
                    String label = "";
                    try {
                        CharSequence cs = info.loadLabel(pm);
                        label = cs == null ? "" : cs.toString();
                    } catch (Exception ignored) {}
                    if (!looksLikeWhatsApp(pkg, label, probe)) continue;
                    String key = pkg + "/" + cls + "/" + probe.getAction() + "/" + (probe.getType() == null ? "" : probe.getType());
                    if (seen.add(key)) {
                        out.add(new WaCandidate(pkg, cls, label, probe.getAction(), probe.getType(), probe.getDataString()));
                    }
                }
            }
            return out;
        }

        private List<WaCandidate> resolveImageShareCandidates(Uri uri, String mimeType, String message) {
            List<WaCandidate> out = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            PackageManager pm = getPackageManager();
            Intent probe = buildImageSendIntent(uri, mimeType, message);
            List<ResolveInfo> resolved = pm.queryIntentActivities(probe, PackageManager.MATCH_DEFAULT_ONLY);
            for (ResolveInfo info : resolved) {
                if (info == null || info.activityInfo == null) continue;
                String pkg = info.activityInfo.packageName == null ? "" : info.activityInfo.packageName;
                String cls = info.activityInfo.name == null ? "" : info.activityInfo.name;
                String label = "";
                try {
                    CharSequence cs = info.loadLabel(pm);
                    label = cs == null ? "" : cs.toString();
                } catch (Exception ignored) {}
                if (!looksLikeWhatsApp(pkg, label, probe)) continue;
                String key = pkg + "/" + cls;
                if (seen.add(key)) out.add(new WaCandidate(pkg, cls, label, Intent.ACTION_SEND, safeImageMime(mimeType), ""));
            }
            return out;
        }

        private boolean looksLikeWhatsApp(String pkg, String label, Intent sourceIntent) {
            String p = (pkg == null ? "" : pkg).toLowerCase(Locale.US);
            String l = (label == null ? "" : label).toLowerCase(Locale.US);
            String data = sourceIntent.getDataString() == null ? "" : sourceIntent.getDataString().toLowerCase(Locale.US);
            if (p.contains("whatsapp") || l.contains("whatsapp")) return true;
            return data.startsWith("whatsapp://");
        }

        private WaCandidate chooseCandidate(List<WaCandidate> candidates, String path) {
            WaCandidate saved = savedCandidate(path, candidates);
            if (saved != null) return saved;
            boolean wantBusiness = "wa2".equals(path);
            for (WaCandidate c : candidates) {
                if (isBusiness(c) == wantBusiness) return c;
            }
            if (wantBusiness && candidates.size() > 1) return candidates.get(1);
            return candidates.isEmpty() ? null : candidates.get(0);
        }

        private WaCandidate savedCandidate(String path, List<WaCandidate> candidates) {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            String pkg = prefs.getString(path + "_pkg", "");
            String cls = prefs.getString(path + "_cls", "");
            if (pkg.isEmpty() || cls.isEmpty()) return null;
            for (WaCandidate c : candidates) {
                if (pkg.equals(c.packageName) && cls.equals(c.className)) return c;
            }
            return null;
        }

        private void saveCandidate(String path, WaCandidate c) {
            if (c == null) return;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString(path + "_pkg", c.packageName)
                .putString(path + "_cls", c.className)
                .putString(path + "_label", c.label)
                .apply();
        }

        private WaCandidate firstDifferent(List<WaCandidate> candidates, WaCandidate selected) {
            for (WaCandidate c : candidates) {
                if (!c.sameComponent(selected)) return c;
            }
            return null;
        }

        private boolean isBusiness(WaCandidate c) {
            String p = (c.packageName == null ? "" : c.packageName).toLowerCase(Locale.US);
            String l = (c.label == null ? "" : c.label).toLowerCase(Locale.US);
            return p.contains("w4b") || p.contains("business") || l.contains("business");
        }

        private String tryOpen(WaCandidate candidate, String phone, String message) {
            if (candidate == null) return "No resolved WhatsApp candidate.";
            runOnUiThread(() -> {
                try {
                    Intent intent = buildCandidateIntent(candidate, phone, message);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                } catch (Exception e) {
                    android.util.Log.e("VBWhatsAppShare", "WhatsApp launch failed", e);
                }
            });
            return null;
        }

        private String tryOpenImage(WaCandidate candidate, Uri uri, String mimeType, String message) {
            if (candidate == null) return "No resolved WhatsApp candidate.";
            runOnUiThread(() -> {
                try {
                    Intent intent = buildImageSendIntent(uri, mimeType, message);
                    intent.setComponent(new ComponentName(candidate.packageName, candidate.className));
                    intent.setPackage(candidate.packageName);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(intent);
                } catch (Exception e) {
                    android.util.Log.e("VBWhatsAppShare", "WhatsApp image launch failed", e);
                }
            });
            return null;
        }

        private String openGeneralImageShareSheet(Uri uri, String mimeType, String message) {
            runOnUiThread(() -> {
                try {
                    Intent send = buildImageSendIntent(uri, mimeType, message);
                    Intent chooser = Intent.createChooser(send, "Share Receipt");
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(chooser);
                } catch (Exception e) {
                    android.util.Log.e("VBWhatsAppShare", "Receipt share sheet launch failed", e);
                }
            });
            return null;
        }

        private String openDialer(String phone) {
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(phone)));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                } catch (Exception e) {
                    android.util.Log.e("VBDialer", "Dialer launch failed", e);
                }
            });
            return null;
        }

        private Intent buildCandidateIntent(WaCandidate candidate, String phone, String message) {
            Intent intent;
            if (!cleanPhone(phone).isEmpty()) {
                intent = buildViewIntent("whatsapp", phone, message);
                intent.setPackage(candidate.packageName);
                return intent;
            } else if (Intent.ACTION_SEND.equals(candidate.action)) {
                intent = buildSendIntent(message);
            } else if (candidate.data != null && candidate.data.startsWith("https://")) {
                intent = buildViewIntent("wa.me", phone, message);
            } else {
                intent = buildViewIntent("whatsapp", phone, message);
            }
            intent.setComponent(new ComponentName(candidate.packageName, candidate.className));
            intent.setPackage(candidate.packageName);
            return intent;
        }

        private Intent buildSendIntent(String message) {
            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType("text/plain");
            intent.putExtra(Intent.EXTRA_TEXT, message == null ? "" : message);
            return intent;
        }

        private Intent buildImageSendIntent(Uri uri, String mimeType, String message) {
            Intent intent = new Intent(Intent.ACTION_SEND);
            intent.setType(safeImageMime(mimeType));
            intent.putExtra(Intent.EXTRA_STREAM, uri);
            if (message != null && !message.trim().isEmpty()) {
                intent.putExtra(Intent.EXTRA_TEXT, message);
            }
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(ClipData.newUri(getContentResolver(), "VasoolBook Receipt", uri));
            return intent;
        }

        private Uri writeReceiptCacheImage(String dataUrl, String mimeType, String filename) throws Exception {
            File dir = new File(getCacheDir(), "receipt-share");
            if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("Could not create receipt cache.");
            File file = new File(dir, sanitizeImageFileName(filename, mimeType));
            try (OutputStream out = new FileOutputStream(file, false)) {
                out.write(decodeDataUrl(dataUrl));
                out.flush();
            }
            return FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", file);
        }

        private byte[] decodeDataUrl(String dataUrl) {
            String raw = dataUrl == null ? "" : dataUrl.trim();
            int comma = raw.indexOf(',');
            if (comma >= 0) raw = raw.substring(comma + 1);
            return Base64.decode(raw, Base64.DEFAULT);
        }

        private String safeImageMime(String mimeType) {
            String m = mimeType == null ? "" : mimeType.toLowerCase(Locale.US).trim();
            if ("image/webp".equals(m) || "image/jpeg".equals(m) || "image/png".equals(m)) return m;
            return "image/png";
        }

        private String sanitizeImageFileName(String filename, String mimeType) {
            String name = filename == null ? "" : filename.trim();
            if (name.isEmpty()) name = "vasoolbook_receipt";
            name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            String lower = name.toLowerCase(Locale.US);
            if (!(lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".webp"))) {
                String ext = "image/webp".equals(safeImageMime(mimeType)) ? ".webp" : ("image/jpeg".equals(safeImageMime(mimeType)) ? ".jpg" : ".png");
                name += ext;
            }
            return name;
        }

        private Intent buildViewIntent(String mode, String phone, String message) {
            String cleanPhone = cleanPhone(phone);
            String encodedMessage = urlEncode(message == null ? "" : message);
            Uri uri;
            if ("wa.me".equals(mode)) {
                String base = cleanPhone.isEmpty() ? "https://wa.me/" : "https://wa.me/" + cleanPhone;
                uri = Uri.parse(encodedMessage.isEmpty() ? base : base + "?text=" + encodedMessage);
            } else {
                String query = "";
                if (!cleanPhone.isEmpty()) query += "phone=" + cleanPhone;
                if (!encodedMessage.isEmpty()) query += (query.isEmpty() ? "" : "&") + "text=" + encodedMessage;
                uri = Uri.parse("whatsapp://send" + (query.isEmpty() ? "" : "?" + query));
            }
            return new Intent(Intent.ACTION_VIEW, uri);
        }

        private String cleanPhone(String phone) {
            if (phone == null) return "";
            String digits = phone.replaceAll("[^0-9]", "");
            if (digits.length() == 10) return "91" + digits;
            return digits;
        }

        private String cleanDialPhone(String phone) {
            if (phone == null) return "";
            String trimmed = phone.trim();
            boolean plus = trimmed.startsWith("+");
            String digits = trimmed.replaceAll("[^0-9]", "");
            if (digits.length() < 7 || digits.length() > 15) return "";
            if (digits.length() == 10) return digits;
            if (plus) return "+" + digits;
            return digits;
        }

        private String urlEncode(String value) {
            try {
                return URLEncoder.encode(value, "UTF-8").replace("+", "%20");
            } catch (Exception e) {
                return "";
            }
        }

        private String waResult(String status, String pkg, String label, String path, String message) {
            JSONObject result = new JSONObject();
            try {
                result.put("status", status);
                result.put("packageName", pkg == null ? "" : pkg);
                result.put("label", label == null ? "" : label);
                result.put("path", path == null ? "" : path);
                result.put("message", message == null ? "" : message);
            } catch (Exception ignored) {}
            return result.toString();
        }
    }

    private static class WaCandidate {
        final String packageName;
        final String className;
        final String label;
        final String action;
        final String type;
        final String data;

        WaCandidate(String packageName, String className, String label, String action, String type, String data) {
            this.packageName = packageName;
            this.className = className;
            this.label = label;
            this.action = action;
            this.type = type;
            this.data = data;
        }

        boolean sameComponent(WaCandidate other) {
            return other != null
                && packageName.equals(other.packageName)
                && className.equals(other.className);
        }
    }

    private class AndroidDeveloperDiagnostics {
        @JavascriptInterface
        public String getReport() {
            JSONObject report = new JSONObject();
            try {
                PackageInfo info = getPackageManager().getPackageInfo(getPackageName(),
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                        ? PackageManager.GET_SIGNING_CERTIFICATES
                        : PackageManager.GET_SIGNATURES);
                report.put("packageName", getPackageName());
                report.put("versionName", info.versionName);
                report.put("versionCode", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode);
                boolean debug = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
                report.put("buildType", debug ? "Debug" : "Release");
                report.put("serverClientId", getStringResource("server_client_id"));
                report.put("defaultWebClientId", getStringResource("default_web_client_id"));
                report.put("googleAppId", getStringResource("google_app_id"));
                report.put("googleApiKey", mask(getStringResource("google_api_key")));
                report.put("firebaseProjectId", getStringResource("project_id"));

                int gps = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(MainActivity.this);
                report.put("googlePlayServicesStatusCode", gps);
                report.put("googlePlayServicesStatus", gps == ConnectionResult.SUCCESS ? "Available" : GoogleApiAvailability.getInstance().getErrorString(gps));

                GoogleSignInAccount account = GoogleSignIn.getLastSignedInAccount(MainActivity.this);
                report.put("googleSignInStatus", account == null ? "Signed out" : "Signed in");
                report.put("currentGoogleAccount", account == null ? "" : account.getEmail());

                Signature[] signatures = signaturesFrom(info);
                if (signatures.length > 0) {
                    report.put("sha1", fingerprint(signatures[0], "SHA-1"));
                    report.put("sha256", fingerprint(signatures[0], "SHA-256"));
                } else {
                    report.put("sha1", "");
                    report.put("sha256", "");
                }
            } catch (Exception e) {
                try {
                    report.put("nativeDiagnosticsException", e.getClass().getName() + ": " + e.getMessage());
                } catch (Exception ignored) {}
            }
            return report.toString();
        }

        private Signature[] signaturesFrom(PackageInfo info) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                SigningInfo signingInfo = info.signingInfo;
                if (signingInfo == null) return new Signature[0];
                return signingInfo.hasMultipleSigners()
                    ? signingInfo.getApkContentsSigners()
                    : signingInfo.getSigningCertificateHistory();
            }
            return info.signatures == null ? new Signature[0] : info.signatures;
        }

        private String getStringResource(String name) {
            int id = getResources().getIdentifier(name, "string", getPackageName());
            return id == 0 ? "" : getString(id);
        }

        private String mask(String value) {
            if (value == null || value.length() < 12) return value == null ? "" : value;
            return value.substring(0, 6) + "..." + value.substring(value.length() - 6);
        }

        private String fingerprint(Signature signature, String algorithm) throws Exception {
            byte[] digest = MessageDigest.getInstance(algorithm).digest(signature.toByteArray());
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < digest.length; i++) {
                if (i > 0) out.append(':');
                out.append(String.format("%02X", digest[i]));
            }
            return out.toString();
        }
    }

    private static class PopupSupportingWebChromeClient extends BridgeWebChromeClient {
        PopupSupportingWebChromeClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            WebView popupWebView = new WebView(view.getContext());
            popupWebView.getSettings().setJavaScriptEnabled(true);
            popupWebView.getSettings().setDomStorageEnabled(true);
            popupWebView.getSettings().setSupportMultipleWindows(true);
            popupWebView.getSettings().setJavaScriptCanOpenWindowsAutomatically(true);

            popupWebView.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    try {
                        Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                        view.getContext().startActivity(intent);
                    } catch (ActivityNotFoundException ex) {
                        // ignore if no handler is available
                    }
                    return true;
                }
            });

            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(popupWebView);
            resultMsg.sendToTarget();
            return true;
        }
    }
}
