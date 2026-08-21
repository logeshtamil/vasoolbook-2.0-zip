@echo off
set "JAVA_HOME=C:\Program Files\Android Studio\jbr"
echo JAVA_HOME=%JAVA_HOME%
if exist "%JAVA_HOME%\bin\java.exe" (echo JAVA exists) else (echo JAVA missing)
if exist "%JAVA_HOME%\bin\javac.exe" (echo JAVAC exists) else (echo JAVAC missing)
dir "%JAVA_HOME%\bin" /b | findstr /i "java.exe javac.exe"
