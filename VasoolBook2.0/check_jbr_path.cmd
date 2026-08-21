@echo off
for %%I in ("C:\Program Files\Android Studio\jbr") do @echo SHORT=%%~sI
if exist "C:\Program Files\Android Studio\jbr\bin\java.exe" (
  echo PATH OK
) else (
  echo PATH FAIL
)
dir "C:\Program Files\Android Studio\jbr\bin" /b
