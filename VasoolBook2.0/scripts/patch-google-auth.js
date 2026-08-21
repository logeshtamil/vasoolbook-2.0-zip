const fs = require('fs');
const path = require('path');

const file = path.join(
  __dirname,
  '..',
  'node_modules',
  '@codetrix-studio',
  'capacitor-google-auth',
  'android',
  'src',
  'main',
  'java',
  'com',
  'codetrixstudio',
  'capacitor',
  'GoogleAuth',
  'GoogleAuth.java'
);

if (!fs.existsSync(file)) {
  console.warn('[patch-google-auth] Plugin source not found, skipping.');
  process.exit(0);
}

let text = fs.readFileSync(file, 'utf8');
if (
  text.includes('rejectWithNativeDetails(') &&
  text.includes('buildAuthTokenScope(') &&
  text.includes('getConfig().getString("serverClientId"')
) {
  console.log('[patch-google-auth] Native GoogleAuth diagnostics patch already applied.');
  process.exit(0);
}

const replace = (from, to) => {
  if (!text.includes(from)) {
    throw new Error('[patch-google-auth] Expected source marker not found.');
  }
  text = text.replace(from, to);
};

replace(
  'import java.io.InputStreamReader;\nimport java.net.HttpURLConnection;',
  'import java.io.InputStreamReader;\nimport java.io.PrintWriter;\nimport java.io.StringWriter;\nimport java.net.HttpURLConnection;'
);
replace(
  'private final static String FIELD_TOKEN_EXPIRES = "expires";',
  'private final static String FIELD_TOKEN_EXPIRES = "expires";\n  private final static String TAG = "VasoolGoogleAuth";'
);
replace(
  'private GoogleSignInClient googleSignInClient;',
  'private GoogleSignInClient googleSignInClient;\n  private String authTokenScope = "oauth2:profile email";'
);
replace(
  'public void loadSignInClient (String clientId, boolean forceCodeForRefreshToken, String[] scopeArray) {\n    GoogleSignInOptions.Builder googleSignInBuilder',
  'public void loadSignInClient (String clientId, boolean forceCodeForRefreshToken, String[] scopeArray) {\n    authTokenScope = buildAuthTokenScope(scopeArray);\n    GoogleSignInOptions.Builder googleSignInBuilder'
);
replace(
  'public void signIn(PluginCall call) {\n    Intent signInIntent',
  'public void signIn(PluginCall call) {\n    if (googleSignInClient == null) {\n      call.reject("GoogleAuth is not initialized. Call GoogleAuth.initialize() with a valid Web OAuth client ID before signIn().", "GOOGLE_AUTH_NOT_INITIALIZED");\n      return;\n    }\n    Intent signInIntent'
);
replace(
  'e.printStackTrace();\n          call.reject("Something went wrong while retrieving access token", e);',
  'rejectWithNativeDetails(call, "Failed while retrieving native Google access token", e);'
);
replace(
  'call.reject("The user canceled the sign-in flow.", "" + e.getStatusCode());\n      } else {\n        call.reject("Something went wrong", "" + e.getStatusCode());',
  'rejectWithNativeDetails(call, "The user canceled the sign-in flow", e);\n      } else {\n        rejectWithNativeDetails(call, "Native Google Sign-In failed", e);'
);
replace(
  'e.printStackTrace();\n        call.reject("Something went wrong while retrieving access token", e);',
  'rejectWithNativeDetails(call, "Failed while refreshing native Google access token", e);'
);
replace(
  'public void signOut(final PluginCall call) {\n    googleSignInClient.signOut()',
  'public void signOut(final PluginCall call) {\n    if (googleSignInClient == null) {\n      call.resolve();\n      return;\n    }\n    googleSignInClient.signOut()'
);
replace(
  'String configClientId = getConfig().getString("androidClientId",\n      getConfig().getString("clientId",\n        this.getContext().getString(R.string.server_client_id)));',
  'String configClientId = getConfig().getString("serverClientId",\n      getConfig().getString("clientId",\n        this.getContext().getString(R.string.server_client_id)));'
);
replace(
  'String clientId = call.getData().getString("clientId", configClientId);',
  'String clientId = call.getData().getString("serverClientId",\n      call.getData().getString("clientId", configClientId));'
);
replace(
  'call.reject("Sign out failed", e);',
  'rejectWithNativeDetails(call, "Native Google Sign-Out failed", e);'
);
replace(
  'String[] scopeArray = replacedScopesStr.split(",");\n\n    loadSignInClient',
  'String[] scopeArray = replacedScopesStr.split(",");\n    if (clientId == null || clientId.trim().isEmpty() || clientId.contains("REPLACE_WITH_WEB_OAUTH_CLIENT_ID")) {\n      call.reject("GoogleAuth.initialize failed: clientId/serverClientId must be the Web OAuth Client ID ending in .apps.googleusercontent.com.", "GOOGLE_AUTH_INVALID_CLIENT_ID");\n      return;\n    }\n    if (!clientId.endsWith(".apps.googleusercontent.com")) {\n      call.reject("GoogleAuth.initialize failed: invalid Web OAuth Client ID: " + clientId, "GOOGLE_AUTH_INVALID_CLIENT_ID");\n      return;\n    }\n\n    loadSignInClient'
);
replace(
  'manager.getAuthToken(account, "oauth2:profile email", null, false, null, null);',
  'manager.getAuthToken(account, authTokenScope, null, false, null, null);'
);
replace(
  '\n  private static String fromStream(InputStream is) throws IOException {',
  `\n  private static String buildAuthTokenScope(String[] scopeArray) {
    StringBuilder builder = new StringBuilder("oauth2:profile email");
    if (scopeArray != null) {
      for (String scope : scopeArray) {
        if (scope != null) {
          String cleaned = scope.trim();
          if (!cleaned.isEmpty() && builder.indexOf(cleaned) < 0) {
            builder.append(' ').append(cleaned);
          }
        }
      }
    }
    return builder.toString();
  }

  private void rejectWithNativeDetails(PluginCall call, String prefix, Exception e) {
    StringWriter sw = new StringWriter();
    e.printStackTrace(new PrintWriter(sw));
    String code = e instanceof ApiException ? String.valueOf(((ApiException) e).getStatusCode()) : e.getClass().getSimpleName();
    String suggestedFix = suggestedFixFor(code, e);
    String message = prefix
      + " | statusCode=" + code
      + " | exception=" + e.getClass().getName()
      + " | message=" + (e.getMessage() == null ? "" : e.getMessage())
      + " | suggestedFix=" + suggestedFix
      + " | stack=" + sw.toString();
    Log.e(TAG, message, e);
    call.reject(message, code, e);
  }

  private String suggestedFixFor(String code, Exception e) {
    String message = e.getMessage() == null ? "" : e.getMessage();
    if ("10".equals(code) || message.contains("DEVELOPER_ERROR")) {
      return "Register this APK signing SHA-1 and SHA-256 in Firebase for package in.vasoolbook.app, re-download google-services.json, and use the Web OAuth Client ID as clientId/serverClientId.";
    }
    if ("12501".equals(code)) {
      return "User cancelled sign-in. Retry and choose a Google account.";
    }
    if ("12500".equals(code)) {
      return "Check OAuth consent screen, Google Play Services, package name, SHA fingerprints, and Web OAuth Client ID in the same Firebase project.";
    }
    if (message.contains("REPLACE_WITH_WEB_OAUTH_CLIENT_ID") || message.contains("GOOGLE_AUTH_INVALID_CLIENT_ID")) {
      return "Set GOOGLE_WEB_CLIENT_ID to the real Web OAuth Client ID, then run npx cap sync android and rebuild.";
    }
    return "Check native Google Sign-In configuration, Firebase OAuth clients, Google Play Services, and Drive API access.";
  }

  private static String fromStream(InputStream is) throws IOException {`
);

fs.writeFileSync(file, text);
console.log('[patch-google-auth] Native GoogleAuth diagnostics patch applied.');
