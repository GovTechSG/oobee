# If currently within script, go one directory up
if ((Split-Path -Path $pwd -Leaf) -eq "scripts") {
	cd ..
}

$ProgressPreferences = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'

# --- Security: SHA-256 verification for every downloaded artifact ---
#
# See the sibling install_oobee_dependencies.command for the rationale.
# In short: this script previously fetched Node.js, Corretto, and the
# veraPDF installer over TLS and immediately unpacked whatever bytes
# arrived. Every download below is now paired with an SHA-256 check
# that terminates the script on mismatch.

$NodeVersion = "22.19.0"
$NodeSha256WinX64 = "ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86" # guardrails-disable-line
$VeraPdfSha256   = "b6c50ab65d574bff0cbc0449ffacf587e325a3a53f8a6ecc0d578966abc800ec" # guardrails-disable-line

# Pin Corretto to a versioned URL + maintainer-verified SHA-256 (asgard-0005).
# Do not use the "latest" URL with the same-origin sidecar digest: sidecar and
# archive share a channel, so a compromised origin defeats the check.
$CorrettoVersion    = "11.0.32.10.1"
$CorrettoSha256Win  = "9f8124aca6b8c3a26226e66730458a46fed2e729097010d574c649b5ac10f89a"

function Assert-Sha256 {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][string]$Expected,
        [Parameter(Mandatory=$true)][string]$Label
    )
    if (-not (Test-Path $Path)) {
        Write-Error "$Label`: expected file '$Path' was not downloaded"
        exit 1
    }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
    $exp = $Expected.ToLowerInvariant()
    if ($actual -ne $exp) {
        Write-Error "$Label`: SHA-256 mismatch (expected $exp, actual $actual)"
        Remove-Item -Force -ErrorAction SilentlyContinue $Path
        exit 1
    }
    Write-Output "OK: $Label`: SHA-256 verified ($exp)"
}

# Install NodeJS binaries
if (-Not (Test-Path nodejs-win\node.exe)) {
    Write-Output "Downloading Node"
    Invoke-WebRequest -o ./nodejs-win.zip "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
    Assert-Sha256 -Path ./nodejs-win.zip -Expected $NodeSha256WinX64 -Label "NodeJS $NodeVersion win-x64"

    Write-Output "Unzip Node"
    Expand-Archive .\nodejs-win.zip -DestinationPath .
    Rename-Item "node-v$NodeVersion-win-x64" -NewName nodejs-win
    Remove-Item -Force .\nodejs-win.zip
}

# Install Coretto-11
if (-Not (Test-Path jre\bin\java.exe)) {
    if (-Not (Test-Path jdk\bin\java.exe)) {
        Write-Output "Downloading Corretto $CorrettoVersion"
        # Versioned URL + pinned SHA-256; do NOT trust Amazon's same-origin
        # latest_sha256 sidecar for integrity.
        Invoke-WebRequest -o ./corretto-11.zip "https://corretto.aws/downloads/resources/$CorrettoVersion/amazon-corretto-$CorrettoVersion-windows-x64-jdk.zip"
        Assert-Sha256 -Path ./corretto-11.zip -Expected $CorrettoSha256Win -Label "Corretto $CorrettoVersion win-x64"

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
    Invoke-WebRequest -o .\verapdf-installer.zip "https://github.com/GovTechSG/oobee/releases/download/cache/verapdf-installer.zip"
    Assert-Sha256 -Path .\verapdf-installer.zip -Expected $VeraPdfSha256 -Label "veraPDF installer"

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
if (Test-Path oobee) {
    Write-Output "Installing node dependencies"
    & ".\oobee_shell_ps.ps1" "cd oobee;npm install --force --omit=dev;cd .."

    # Omit installing Playwright browsers as it is not reuqired
    # Write-Output "Install Playwright browsers"
    # & ".\oobee_shell_ps.ps1" "npx playwright install chromium"

    try {
	Write-Output "Building Typescript"
	& ".\oobee_shell_ps.ps1" "cd oobee;npm run build"
    } catch {
	Write-Output "Build with some errors but continuing. $_.Exception.Message"
    }

    if (Test-Path oobee\.git) {
        Write-Output "Unhide .git folder"
        attrib -s -h oobee\.git
    }

} else {
    Write-Output "Trying to search for package.json instead"

    if (Test-Path package.json) {
        Write-Output "Installing node dependencies"
        & ".\oobee_shell_ps.ps1" "npm install --force --omit=dev"

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
        Write-Output "Could not find oobee"
    }
}
