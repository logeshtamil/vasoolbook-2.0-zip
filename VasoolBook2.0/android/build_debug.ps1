$ErrorActionPreference = 'Stop'
Set-Location 'C:\Vasool Book 2.0\android'
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:Path = "$($env:JAVA_HOME)\bin;$env:Path"
Write-Output "JAVA_HOME=$env:JAVA_HOME"
Write-Output "Java version:"
java -version 2>&1 | ForEach-Object { Write-Output $_ }
Write-Output "Gradle wrapper:"
Write-Output (Resolve-Path .\gradlew.bat)
Write-Output "Building APK..."
.\gradlew.bat assembleDebug 2>&1 | ForEach-Object { Write-Output $_ }
Write-Output "Build command finished."
