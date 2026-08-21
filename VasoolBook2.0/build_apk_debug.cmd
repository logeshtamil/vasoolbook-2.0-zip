@echo off
setlocal enableextensions enabledelayedexpansion
echo CurrentDir=%CD%
echo PATH=%PATH%
echo JAVA_HOME before set=%JAVA_HOME%
set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
echo JAVA_HOME after set=%JAVA_HOME%
if exist "%JAVA_HOME%\bin\java.exe" (echo [OK] java.exe exists) else (echo [ERROR] java.exe missing)
if exist "%JAVA_HOME%\bin\javac.exe" (echo [OK] javac.exe exists) else (echo [ERROR] javac.exe missing)
dir "%JAVA_HOME%\bin" /b 2>nul
echo ---
if exist "%~dp0android" (echo [OK] android dir exists: %~dp0android) else (echo [ERROR] android dir missing: %~dp0android)
cd /d "%~dp0android"|| (echo [ERROR] cd failed & exit /b 1)
echo ChangedDir=%CD%
dir . /b
echo ---
set "PATH=%JAVA_HOME%\bin;%PATH%"
"%JAVA_HOME%\bin\java.exe" -version
"%JAVA_HOME%\bin\javac.exe" -version
call gradlew.bat assembleDebug
endlocal
