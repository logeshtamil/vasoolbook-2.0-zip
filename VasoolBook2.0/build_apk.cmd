@echo off
set "JAVA_HOME=C:\Program Files\Android Studio\jbr"
set "PATH=%JAVA_HOME%\bin;%PATH%"
cd /d "%~dp0android"
"%JAVA_HOME%\bin\java.exe" -version
"%JAVA_HOME%\bin\javac.exe" -version
gradlew.bat assembleDebug
