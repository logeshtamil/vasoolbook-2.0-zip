/*
 * PLACEHOLDER — NOT THE REAL PLUGIN BUNDLE.
 *
 * This file must be replaced with the actual browser bundle from:
 *   node_modules/@codetrix-studio/capacitor-google-auth/dist/plugin.js
 *
 * after running, in the project root:
 *   npm install
 *   npx cap sync android
 *
 * This project loads Capacitor plugins via a plain <script> tag (no bundler), so the
 * plugin's compiled web binding has to be copied into www/ manually as part of the
 * build/deploy process (see README_DEPLOY_ANDROID_VSCODE.md), the same way cordova.js
 * and cordova_plugins.js are already copied into android/app/src/main/assets/public/.
 *
 * This environment has no network access to npm, so the real plugin bundle could not
 * be fetched/generated here. Do not ship this placeholder — it intentionally throws if
 * the app tries to use it, so a missing real build is caught immediately during testing
 * rather than silently failing at Google Sign-In time.
 */
(function () {
  function notInstalled() {
    throw new Error(
      'capacitor-google-auth.js placeholder is still in place. Run "npm install" + ' +
      '"npx cap sync android" and copy the real dist/plugin.js over this file.'
    );
  }
  window.Capacitor = window.Capacitor || {};
  window.Capacitor.Plugins = window.Capacitor.Plugins || {};
  // Intentionally NOT registering a working GoogleAuth object here — see notice above.
  // (Leaving Capacitor.Plugins.GoogleAuth undefined means _gdGisReady() correctly
  // reports "not ready" instead of pretending to work.)
  console.warn('[VasoolBook] capacitor-google-auth.js placeholder loaded — native Google Sign-In is NOT wired up yet.');
})();
