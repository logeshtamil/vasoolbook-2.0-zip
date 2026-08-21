# Vasool Book Android Deploy Package — VS Code

This package uses your latest uploaded HTML file as the Android app source:

- `www/index.html` — Vasool Book 2.0 app
- `package.json` — Capacitor dependencies and commands
- `capacitor.config.js` — Android package/app configuration (JS format so serverClientId can read GOOGLE_WEB_CLIENT_ID from the environment; see TESTING.md)

## 1. Open in VS Code

Extract this ZIP, then open this folder in VS Code:

```bash
cd VasoolBook_Android_VSCode_Latest
code .
```

## 2. Install requirements

Install once on your computer:

- Node.js LTS
- VS Code
- Android Studio
- Android SDK / Platform Tools
- JDK 17 or the JDK bundled with Android Studio

## 3. Install Capacitor packages

In VS Code Terminal:

```bash
npm install
```

## 4. Create Android project folder

Run only the first time:

```bash
npm run android:add
```

This creates the `android/` folder.

## 5. Sync latest HTML to Android

Run this every time after editing `www/index.html`:

```bash
npm run android:sync
```

## 6. Open Android Studio

```bash
npm run android:open
```

In Android Studio:

```text
Build > Build Bundle(s) / APK(s) > Build APK(s)
```

Debug APK path will usually be:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## 7. After future HTML changes

Replace only this file:

```text
www/index.html
```

Then run:

```bash
npm run android:sync
npm run android:open
```

## Common fixes

### If `npx cap add android` says Android already exists
Use:

```bash
npm run android:sync
```

### If Gradle/JDK error comes
Open Android Studio once and let it finish downloading Gradle and SDK files.

### If app needs internet for Google Fonts / Google Drive / QR libraries
Make sure Android has internet permission. Capacitor normally adds it, but check:

```text
android/app/src/main/AndroidManifest.xml
```

It should contain:

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

## Tamil quick steps

1. ZIP extract பண்ணுங்கள்.
2. VS Code-ல் folder open பண்ணுங்கள்.
3. Terminal-ல் `npm install` run பண்ணுங்கள்.
4. First time மட்டும் `npm run android:add` run பண்ணுங்கள்.
5. `npm run android:sync` run பண்ணுங்கள்.
6. `npm run android:open` run பண்ணி Android Studio-ல் APK build பண்ணுங்கள்.
