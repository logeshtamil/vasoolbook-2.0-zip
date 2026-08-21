# TESTING.md — Native Google Sign-In (Build & Test Guide)

This covers what's needed to actually build and manually test the native Google
Sign-In / Drive backup integration in VasoolBook 2.0.

---

## 1. Prerequisites (one-time setup)

### 1.1 Firebase / Google Cloud
1. Open the Firebase console for project **`vasool-book-app-41921`**.
2. **Project settings → Your apps → Android app (`in.vasoolbook.app`) → Add fingerprint.**
   Add **both**:
   - Your **debug** keystore's SHA-1 and SHA-256
     (`cd android && ./gradlew signingReport` → look under `Variant: debug`).
   - Your **release** keystore's SHA-1 and SHA-256 (same command, `Variant: release`,
     once you have a real release signing config).
3. Re-download `google-services.json` and replace
   `android/app/google-services.json`. Its `oauth_client` array must no longer be empty.
   (A Gradle check now warns you at build time — see §3 — if you forget this.)
4. In **Google Cloud Console → APIs & Services → Credentials**, confirm a
   **Web application** OAuth Client ID exists in the same project (Firebase usually
   creates one automatically alongside the Android client once fingerprints are added).
   Copy this Client ID — it's your `GOOGLE_WEB_CLIENT_ID`.
5. **APIs & Services → Library → Google Drive API → Enable** (if not already enabled).
6. **OAuth consent screen**: either publish it, or add your test Google account under
   **Test users** while it's still in "Testing" mode.

### 1.2 Configure the Client ID (Task 1 — now configurable, not hardcoded)
Set the `GOOGLE_WEB_CLIENT_ID` value **before** running any `cap`/Gradle
command. Both `capacitor.config.js` and `android/app/build.gradle` read the same value,
so you only set it once. Pick one:

- **Per-shell-session (quick, temporary):**
  ```bash
  export GOOGLE_WEB_CLIENT_ID="123456789-abc.apps.googleusercontent.com"
  ```
- **Persistent, per-developer (recommended):** add a line to `android/local.properties`
  (already gitignored — see `android/.gitignore`):
  ```properties
  GOOGLE_WEB_CLIENT_ID=123456789-abc.apps.googleusercontent.com
  ```
  This is read automatically by both `capacitor.config.js` and `android/app/build.gradle`.
- **CI/CD:** set `GOOGLE_WEB_CLIENT_ID` as a pipeline secret/environment variable.

If unset, both files fall back to a clearly-named placeholder
(`REPLACE_WITH_WEB_OAUTH_CLIENT_ID.apps.googleusercontent.com`) so the project still
builds — but native sign-in will fail at runtime until a real value is set.

### 1.3 Install/sync the native plugin
The app uses Capacitor's generated native plugin bridge. Do not add a GIS or GoogleAuth
web shim for Android. Just install and sync:
```bash
npm install
npx cap sync android
```

---

## 2. Build

```bash
npm install
npx cap sync android
npm run build:apk:debug        # or: cd android && ./gradlew assembleDebug
```

Watch the build output for two things (both new build-time checks added in this pass):

- **`checkGoogleServicesOAuthClient`** (task 4) prints a warning if
  `google-services.json` is missing or its `oauth_client` array is still empty — fix
  per §1.1 before proceeding.
- If `GOOGLE_WEB_CLIENT_ID` was never set, `capacitor.config.js` / `strings.xml`
  will silently carry the placeholder value — sign-in will fail at runtime with a
  `DEVELOPER_ERROR` (see §4 Troubleshooting).

Install on a device/emulator with Google Play Services:
```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 3. What was verified this pass (Tasks 5 & 6)

- **GoogleAuth plugin initialization (Task 5):** every native call path now calls
  `GoogleAuth.initialize()` first, guarded by an idempotent flag so it only runs once:
  - `_gdEnsureToken()` (used by Sign In / Silent Login) → via `_gdInitAuth()`.
  - `_gdSignOut()` → **fixed in this pass** to call `_gdInitAuth()` before
    `GoogleAuth.signOut()` (previously it could call `signOut()` on an
    un-initialized client if the user signed out before ever signing in).
  - `DriveService.getAccessToken()` (used by Backup/Restore) → via its own internal
    `_initAuth()`, independent of the above but calling the same native
    `GoogleAuth.initialize()`.
- **AndroidManifest permissions (Task 6):** only `android.permission.INTERNET` is
  declared, and that is confirmed sufficient — the modern `GoogleSignInClient` API used
  by this plugin does not require `GET_ACCOUNTS`, `ACCESS_NETWORK_STATE`, or any other
  permission; connectivity pre-checks in the app use the WebView's `navigator.onLine`,
  not a native API. No manifest changes were needed here.

---

## 4. Manual test steps

Run these in order on a real device or emulator with Google Play Services and at
least one Google account already added in Android **Settings → Accounts**.

### 4.1 Sign In
1. Open the app → **Settings → Backup** (Google Drive card).
2. Tap **🔗 Connect Google Drive**.
3. **Expect:** the native account chooser sheet opens (not a WebView popup). Pick an
   account → consent screen (first time only) → sheet closes → status dot turns green,
   text reads "Connected — ready to backup".
4. **Fail case to check:** if you see `DEVELOPER_ERROR`, re-check §1.1 steps 2–3
   (fingerprints / Client ID mismatch) — this is the #1 native sign-in failure cause.

### 4.2 Silent Login
1. Force-close the app completely (swipe away from recents).
2. Re-open the app and go to **Settings → Backup**.
3. **Expect:** status shows "Connected" **without any account chooser or prompt
   appearing** — this is `_gdSilentLogin()` restoring the previous session quietly.
4. To confirm it's actually silent (not skipping the check): temporarily add
   `console.log` around `_gdSilentLogin()` in `initGDriveUI()`, or watch `adb logcat`
   for `[GDrive/Diag] initGDriveUI` — you should see a success log with no UI shown.

### 4.3 Sign Out
1. In **Settings → Backup**, tap **✕ Change Client ID**.
2. Confirm the dialog.
3. **Expect:** status returns to "Not signed in — tap Connect". Force-close and
   reopen the app — Silent Login (§4.2) should now find no session and stay
   disconnected (no crash, no prompt).

### 4.4 Backup (writes to Drive AppData folder)
1. Sign in (§4.1) if not already.
2. Tap **☁️ Backup to Drive**.
3. **Expect:** toast "☁️ Backup saved to Google Drive". Status panel's "Backup File"
   row shows `backup.json (Drive AppData)`.
4. **Verifying it actually landed in Drive** (AppData files are hidden from the
   normal Drive UI/website by design):
   - Easiest: use [Google OAuth Playground](https://developers.google.com/oauthplayground)
     or `curl` with a valid access token:
     ```bash
     curl -H "Authorization: Bearer <token>" \
       "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name,modifiedTime,size)"
     ```
     You should see a `backup.json` entry.
   - Or temporarily add a `console.log(JSON.stringify(meta))` after the
     `DriveService.upload(...)` call in `backupToDrive()` and check `adb logcat` for
     the returned file `id`.

### 4.5 Restore (reads from Drive AppData folder)
1. Change some data locally (e.g. add a test borrower) so you can visually confirm
   the restore actually replaced it.
2. Tap **📂 Restore from Drive**.
3. Confirm the "This will REPLACE all current data" dialog.
4. **Expect:** toast "✅ Restored v… — N borrowers…", and the test change from step 1
   is gone (replaced by the backed-up data).
5. **No-backup-yet case:** on a fresh AppData folder (or a different Google account
   that's never backed up), tapping Restore should show "⚠️ No backup found in Google
   Drive" rather than an error.

### 4.6 Regression check — guard dialogs still fire
1. Make a local change, then immediately tap Restore **without backing up first**.
2. **Expect:** the existing "unsynced local changes" guard dialog still appears before
   the restore confirmation (this logic was not touched in this migration).

---

## 5. Troubleshooting quick reference

| Symptom | Likely cause | Fix |
|---|---|---|
| `DEVELOPER_ERROR` / error code 10 on Connect | SHA-1/SHA-256 not registered, or `GOOGLE_WEB_CLIENT_ID` doesn't match the Web client in the same Firebase project | Redo §1.1 steps 2–4 |
| Sign-in sheet opens but immediately closes with no account picked | No Google account on device, or Play Services outdated | Add an account in Android Settings; update Play Services |
| `Native Google Sign-In plugin is unavailable on this build` | `www/js/vendor/capacitor-google-auth.js` is still the placeholder, or `capacitor.plugins.json` wasn't regenerated | Redo §1.3; confirm `android/app/src/main/assets/capacitor.plugins.json` lists `@codetrix-studio/capacitor-google-auth` |
| Backup succeeds but Restore says "No backup found" | Signed in with a **different** Google account than the one used for Backup (AppData is per-account, per-app) | Sign in with the same account, or re-run Backup on the current account |
| Gradle prints the `oauth_client` warning every build | `google-services.json` still has the empty array | Redo §1.1 steps 2–3 |

---

## 6. What was intentionally NOT changed in this pass

Per the task constraints ("do not modify UI or business logic"):
- No buttons, labels, dialogs, or screens were added/removed/reworded.
- No borrower/loan/collection business logic was touched.
- `google-services.json` itself was **not** edited (it must come from a real Firebase
  download — fabricating values into it would break the build in a worse, less
  obvious way). A build-time check (Task 4) now warns instead.
