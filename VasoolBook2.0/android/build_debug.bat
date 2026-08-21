@echo off
set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
set "PATH=%JAVA_HOME%\bin;%PATH%"
echo JAVA_HOME=%JAVA_HOME%
where java
echo Building APK...
gradlew.bat assembleDebug
echo Build finished with errorlevel %ERRORLEVEL%
pause
