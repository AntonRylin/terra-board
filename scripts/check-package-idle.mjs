// electron-builder cleans its output before packaging. Refuse to touch a running copy.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

if (process.platform === 'win32') {
  const directory = resolve('release/win-unpacked');
  try {
    const running = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:TERRA_PACKAGE_DIR + "\\", [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { "{0} (PID {1})" -f $_.Name, $_.ProcessId }',
      ],
      {
        env: { ...process.env, TERRA_PACKAGE_DIR: directory },
        encoding: 'utf8',
        windowsHide: true,
      },
    ).trim();
    if (running) {
      console.error(
        `Close Terra Board and its MCP background connection before rebuilding.\n${running}\nThe existing app has been left intact.`,
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      'Could not check whether Terra Board is running. Packaging stopped.',
      error.message,
    );
    process.exitCode = 1;
  }
}
