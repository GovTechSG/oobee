# If currently within script, go one directory up
if ((Split-Path -Path $pwd -Leaf) -eq "scripts") {
	cd ..
}

$ProgressPreferences = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

# Install NodeJS binaries
if (-Not (Test-Path nodejs-win\node.exe)) {
    Write-Output "Downloading Node"
    Invoke-WebRequest -o ./nodejs-win.zip "https://nodejs.org/dist/v22.19.0/node-v22.19.0-win-x64.zip"     
    
    Write-Output "Unzip Node"
    Expand-Archive .\nodejs-win.zip -DestinationPath .
    Rename-Item node-v22.19.0-win-x64 -NewName nodejs-win
    Remove-Item -Force .\nodejs-win.zip
}

# Install Coretto-11
if (-Not (Test-Path jre\bin\java.exe)) {
    if (-Not (Test-Path jdk\bin\java.exe)) {
        Write-Output "Downloading Corretto-11"
        Invoke-WebRequest -o ./corretto-11.zip "https://corretto.aws/downloads/latest/amazon-corretto-11-x64-windows-jdk.zip"     
        
        Write-Output "Unzip Corretto-11"
        Expand-Archive .\corretto-11.zip -DestinationPath .
        Get-ChildItem ./jdk* -Directory | Rename-Item -NewName jdk
        Remove-Item -Force .\corretto-11.zip
    }

    Write-Output "Set path to JDK"
    $env:JAVA_HOME = "$PWD\jdk"
    $env:Path = "$env:JAVA_HOME\bin;$env:Path"

    Write-Output "Build JRE SE"
    Start-Process jlink -ArgumentList "--output jre --add-modules java.se" -Wait -NoNewWindow
}

# Install VeraPDF
if (-Not (Test-Path verapdf\verapdf.bat)) {
    Write-Output "INFO: Downloading VeraPDF"
    Invoke-WebRequest -o .\verapdf-installer.zip "https://github.com/GovTechSG/a11y-assist/releases/download/cache/verapdf-installer.zip"
    Expand-Archive .\verapdf-installer.zip -DestinationPath .
    Get-ChildItem ./verapdf-greenfield-* -Directory | Rename-Item -NewName verapdf-installer

    Write-Output "INFO: Set path to JRE for this session"
    $env:JAVA_HOME = "$PWD\jre"
    $env:Path = "$env:JAVA_HOME\bin;$env:Path"

    Write-Output "INFO: Installing VeraPDF"
    .\verapdf-installer\verapdf-install "$PWD\verapdf-auto-install-windows.xml"
    Move-Item -Path C:\Windows\Temp\verapdf -Destination verapdf
    Remove-Item -Force -Path .\verapdf-installer.zip 
    Remove-Item -Force -Path .\verapdf-installer -recurse
}

# Check if the jdk directory exists and remove
if (Test-Path -Path .\jdk -PathType Container) {
    # Remove the directory forcefully
    Remove-Item -Path .\jdk -Recurse -Force
}

# Install Node dependencies
if (Test-Path a11y-assist) {
    Write-Output "Installing node dependencies"
    & ".\a11y_assist_shell_ps.ps1" "cd a11y-assist;npm install --force --omit=dev;cd .."

    # Omit installing Playwright browsers as it is not reuqired
    # Write-Output "Install Playwright browsers"
    # & ".\a11y_assist_shell_ps.ps1" "npx playwright install chromium"
    
    try {
	Write-Output "Building Typescript" 
	& ".\a11y_assist_shell_ps.ps1" "cd a11y-assist;npm run build" 
    } catch {
	Write-Output "Build with some errors but continuing. $_.Exception.Message" 
    } 
    
    if (Test-Path a11y-assist\.git) {
        Write-Output "Unhide .git folder"
        attrib -s -h a11y-assist\.git
    }

} else {
    Write-Output "Trying to search for package.json instead"

    if (Test-Path package.json) {
        Write-Output "Installing node dependencies"
        & ".\a11y_assist_shell_ps.ps1" "npm install --force --omit=dev" 

        Write-Output "Install Playwright browsers"
        & "npx playwright install chromium"

        if (Test-Path .git) {
            Write-Output "Unhide .git folder"
            attrib -s -h .git
        }
	
	try {
		Write-Output "Building Typescript" 
		npm run build
 	} catch {
 		Write-Output "Build with some errors but continuing" 
	} 

    } else {
        Write-Output "Could not find A11y Assist"
    }
}
