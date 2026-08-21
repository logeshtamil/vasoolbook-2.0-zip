# CHANGELOG — VasoolBook 2.0 Native Google Sign-In Migration

All notable changes for the Web OAuth → Native Google Sign-In migration, in order.
Dates reflect this working session (2026-07-11).

---

## [Unreleased] — Integration completion pass (this entry)

Review pass completing the native Google Sign-In integration end-to-end. No UI or
business logic changed — see `TESTING.md` for full build/test steps.

### Added
- **Task 1 — configurable `serverClientId`:** `capacitor.config.json` converted to
  `capacitor.config.js`, which reads `GOOGLE_WEB_CLIENT_ID` from the environment at
  `cap sync` time (falls back to the existing placeholder if unset). Mirrored on the
  Android side: `android/app/build.gradle` now resolves the same variable (env var, then
  `android/local.properties`, then placeholder) and injects it via `resValue "string",
  "server_client_id"`; the previously-hardcoded value in `strings.xml` was removed to
  avoid a duplicate-resource conflict with the injected one.
- **Task 4 — `google-services.json` integration check:** new Gradle task
  `checkGoogleServicesOAuthClient`, wired into `preBuild`, which warns at build time
  (not silently at runtime) if `google-services.json` is missing or its `oauth_client`
  array is still empty, with a pointer to the fix steps in `TESTING.md`.
- **`TESTING.md`** (Task 7) — build prerequisites, the `GOOGLE_WEB_CLIENT_ID` setup
  flow, and manual test steps for Sign In / Silent Login / Sign Out / Backup / Restore,
  plus a troubleshooting table.

### Fixed
- **Task 5 — plugin initialization:** `_gdSignOut()` could call the native
  `GoogleAuth.signOut()` before `GoogleAuth.initialize()` had ever run (e.g. a user
  backing out immediately without signing in first). Now calls `_gdInitAuth()` first,
  matching the pattern already used by sign-in/silent-login.

### Verified (no change needed)
- **Task 2:** Backup and Restore were already fully connected to `DriveService`
  (`upload()`/`download()`, AppData folder) from the two prior turns — confirmed via
  code inspection, no further wiring required.
- **Task 6 — AndroidManifest permissions:** `INTERNET` is declared and is the only
  permission the native `GoogleSignInClient` API requires; no additions needed.

### Removed / cleaned up (Task 3 — last remnants of web OAuth)
- Trimmed the last two comments that referenced the old web-GIS `disallowed_useragent`
  restriction (documentation only, not functional code — everything functional was
  already removed in the prior cleanup pass).
- Fixed stale `capacitor.config.json` filename references (now `capacitor.config.js`)
  in comments across `www/index.html`, `www/js/driveService.js`, and
  `README_DEPLOY_ANDROID_VSCODE.md`.

---

## Cleanup pass (previous session entry)

### Removed (dead code)
- **`www/index.html`**
  - `_gdFetch()` — the old generic authenticated-fetch-with-retry helper. Unused since Backup/Restore moved to `DriveService`.
  - `_gdFindFile()` — Drive file lookup by name in the general Drive space. Unused since Restore moved to `DriveService.download()` (AppData folder).
  - `_gdRefreshToken()` — silent-refresh wrapper. Its only caller was `_gdFetch()`, also removed.
  - `_gdClientId()` — localStorage Client-ID getter wrapper. Had zero remaining callers (all call sites now read `localStorage` directly, or don't need it under native sign-in).
  - `_GD_SCOPE` constant — unused; OAuth scopes are now defined in `capacitor.config.json → plugins.GoogleAuth.scopes`, not here.
  - `_GD_FILE_NAME` constant (`'vasoolbook_backup.json'`, general Drive space) — no longer referenced anywhere now that both Backup and Restore use `_GD_APPDATA_FILE_NAME` (`'backup.json'`, AppData folder).
  - `gis-load-indicator` `<span>` + its `gisSpinner` CSS `@keyframes` — orphaned UI left over from the web-GIS script-loading flow; `setGDriveStatus()` never enters a `'loading'` state anymore, so this markup was permanently invisible dead weight.
  - Duplicate `function $id(i){ return document.getElementById(i); }` — this helper was defined **twice** in the file (a pre-existing duplication, not introduced by this migration). Removed the second, redundant definition.
- **`www/js/driveService.js`**
  - Unused `SCOPE` constant (declared, never referenced — actual scope is enforced by `capacitor.config.json`).

### Changed
- `setGDriveStatus()` — simplified: dropped the `'loading'` state branch and its DOM lookup (`gis-load-indicator`), since nothing sets that state anymore.
- Settings status panel's "Backup File" row now displays `_GD_APPDATA_FILE_NAME` (`backup.json (Drive AppData)`) instead of the stale, no-longer-used `_GD_FILE_NAME`.

### Result
- `www/index.html`: 26,137 → 25,992 lines (net −145 lines of dead/duplicate code removed; earlier turns in this migration added diagnostics/native-auth code that offset some of the raw deletions).
- No functional behavior changed — every function/constant removed had **zero** remaining callers, verified by grep sweep before removal.
- Both `index.html`'s inline script and `driveService.js` re-validated with `node --check` after cleanup.

---

## Migration history (earlier turns, for reference)

### 1. Audit (`AUDIT.md`)
Read-only analysis of the existing web-based GIS OAuth flow, Drive backup logic, Capacitor plugin setup, and Firebase config. Identified that the app used a browser-popup OAuth flow (Google Identity Services) inside a Capacitor WebView — a pattern Google's own security policy blocks in production (`disallowed_useragent`).

### 2. Plan (`NATIVE_AUTH_PLAN.md`)
Scoped exactly which functions were "web OAuth" (removable) vs. Drive business logic (must stay), and flagged that `MainActivity.java`'s popup-window handler is shared with unrelated document/report features and must not be touched.

### 3. Remove Web OAuth + scaffold native plugin
- Removed the GIS `<script>` tag and all `google.accounts.oauth2`-based functions (`_onGisLoaded`, `_gdEnsureGisScript`, `_gdBuildClient`, etc.) from `www/index.html`.
- Added `@codetrix-studio/capacitor-google-auth` to `package.json`, wired `capacitor.config.json` (`plugins.GoogleAuth`), and added a placeholder `www/js/vendor/capacitor-google-auth.js` (real plugin bundle must be copied in after `npm install` + `npx cap sync`).

### 4. Configure Android for native sign-in
- `AndroidManifest.xml`: added the `com.google.android.gms.version` meta-data.
- `android/app/build.gradle`: moved `apply plugin: 'com.google.gms.google-services'` to the bottom of the file (Google's documented requirement) and added an explicit `play-services-auth` dependency.
- `google-services.json` deliberately left untouched — its empty `oauth_client` array can only be populated by registering the app's SHA-1/SHA-256 fingerprints in the Firebase console and re-downloading the file (see **Known follow-ups** below).

### 5. Implement native Sign In / Silent Login / Sign Out
Added `_gdInitAuth()`, `_gdSignIn()`, `_gdSilentLogin()`, `_gdSignOut()` in `www/index.html`, all built on a single `_gdEnsureToken(mode)` (`'interactive'` vs `'silent'`). Fixed a bug where silent refresh used to fall back to an interactive popup — silent mode is now strictly silent. Wired into the *existing* UI (Connect button → Sign In, app-boot `initGDriveUI()` → Silent Login, "Change Client ID" link → Sign Out) with zero new buttons.

### 6. `driveService.js` (created, initially unconnected)
Standalone module exposing `DriveService.getAccessToken()/upload()/download()`, self-contained and not referenced anywhere — built and validated in isolation before being wired in.

### 7. Connect Backup → native Drive (AppData folder)
- Added `<script src="js/driveService.js">` to `index.html`.
- `backupToDrive()` rewritten to call `DriveService.upload('backup.json', payload, {space:'appDataFolder'})`.
- Added `drive.appdata` OAuth scope to `capacitor.config.json` (additive — kept `drive.file` too).
- `driveService.js` extended with `options.space` support and fixed to try a silent token before interactive (avoids a redundant popup).

### 8. Connect Restore → native Drive (AppData folder)
`restoreFromDrive()` rewritten to call `DriveService.download('backup.json', {space:'appDataFolder'})`, replacing the old `_gdFindFile()` + manual `alt=media` fetch. `backupToDrive()` left untouched. Backup and Restore now target the same file/location for the first time since the migration began.

---

## Known follow-ups (still outstanding after this session)

1. **`google-services.json` still has an empty `oauth_client` array.** Native sign-in cannot actually complete until the app's debug **and** release SHA-1/SHA-256 fingerprints are registered in the Firebase console and the file is re-downloaded. *(A Gradle build-time warning for this was added this session — see Task 4 above — but the file itself still needs the real download, which requires Firebase console access this environment doesn't have.)*
2. **`GOOGLE_WEB_CLIENT_ID` still needs a real value.** It's now configurable (Task 1 — env var / `local.properties`, no more hardcoded JSON), but someone still needs to set it to the real Web OAuth Client ID once (1) exists. See `TESTING.md` §1.2.
3. **`www/js/vendor/capacitor-google-auth.js` is still a placeholder** — must be replaced with the real `node_modules/@codetrix-studio/capacitor-google-auth/dist/plugin.js` after `npm install` + `npx cap sync android`. See `TESTING.md` §1.3.
4. **Architectural duplication:** `index.html` still keeps its own inline token cache/sign-in wrapper (`_gdriveToken`, `_gdSignIn`, `_gdSilentLogin`, `_gdSignOut`, used for UI status + guard checks) *separate from* `DriveService`'s own internal token cache (used for the actual upload/download transport). Both now correctly call `GoogleAuth.initialize()` before use (Task 5), and stay in sync in practice, but a future pass could consolidate them into one source of truth if desired. Not attempted here — no explicit request, and it's working correctly as-is.
5. **Settings UI's "setup section"** (manual Client-ID paste field) is still permanently hidden (`initGDriveUI()` always hides it) since native sign-in doesn't need a runtime-entered Client ID. The markup and its `saveGDriveClientId()`/`clearGDriveClientId()` handlers are still present/functional but effectively dormant — left in place since removing UI wasn't requested.
