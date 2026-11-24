import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowsPowerShell } from "./scheduler.js";

/**
 * Desktop notifications from the unattended job. Never throws: a machine that
 * cannot show a notification must still sync.
 */

function xmlText(text: string): string {
  return (
    String(text)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: XML rejects control characters, so they are stripped
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
  );
}

/**
 * The PowerShell script that shows a Windows toast. Windows PowerShell 5.1 is
 * used because it projects the WinRT types implicitly; the script travels as
 * base64 UTF-16LE so non-ASCII text never crosses an ANSI code page.
 */
export function windowsToastScript(title: string, body: string): string {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlText(title)}</text><text>${xmlText(body)}</text></binding></visual></toast>`;
  // Windows PowerShell's own AppUserModelID is always registered; an
  // unregistered id makes Windows drop the toast silently.
  const appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
  return [
    "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]",
    "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime]",
    "$d = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$d.LoadXml('${xml.replace(/'/g, "''")}')`,
    "$t = New-Object Windows.UI.Notifications.ToastNotification $d",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show($t)`,
  ].join("\n");
}

export function appleScriptNotification(title: string, body: string): string {
  const flat = (s: string) => String(s).replace(/[\n\r\u2028\u2029]+/g, " · ");
  const quote = (s: string) => `"${flat(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `display notification ${quote(body)} with title ${quote(title)}`;
}

export const NOTIFY_TASK_NAME = "OpenCodeSyncNotify";

/**
 * The VBScript that shows a toast in the user's session without any window:
 * `WScript.Shell.Run` with window style 0 starts Windows PowerShell hidden,
 * so no console or terminal tab ever flashes.
 */
export function notifyLauncherScript(
  toastScript: string,
  powershell = windowsPowerShell(),
): string {
  const encoded = Buffer.from(toastScript, "utf16le").toString("base64");
  return `CreateObject("WScript.Shell").Run """${powershell}"" -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}", 0, False\r\n`;
}

/**
 * The PowerShell that registers a one-shot task with an Interactive principal
 * (it runs in the signed-in user's own session), starts it, and removes it.
 */
export function notifyRegisterScript(vbsPath: string, taskName = NOTIFY_TASK_NAME): string {
  const quoted = vbsPath.replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B "' + '${quoted}' + '"')`,
    "$p = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
    "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 1)",
    `Register-ScheduledTask -TaskName '${taskName}' -Action $a -Principal $p -Settings $s -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${taskName}'`,
    "Start-Sleep -Seconds 8",
    `Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false`,
  ].join("\n");
}

/**
 * Show a toast in the signed-in user's desktop session from a session that
 * has none. Returns false when nobody is signed in or registration fails.
 */
export function notifyViaUserSession(toastScript: string): boolean {
  try {
    const dir = path.join(os.tmpdir(), "opencode-sync-notify");
    fs.mkdirSync(dir, { recursive: true });
    const vbs = path.join(dir, "toast.vbs");
    // UTF-16LE with a BOM: wscript reads anything else in the ANSI code page,
    // which breaks a non-ASCII profile path.
    fs.writeFileSync(
      vbs,
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(notifyLauncherScript(toastScript), "utf16le"),
      ]),
    );
    const encoded = Buffer.from(notifyRegisterScript(vbs), "utf16le").toString("base64");
    execFileSync(
      windowsPowerShell(),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      {
        stdio: "ignore",
        windowsHide: true,
        timeout: 40_000,
      },
    );
    return true;
  } catch {
    return false;
  }
}

export function notify(title: string, body: string, platform = process.platform): boolean {
  try {
    if (platform === "win32") {
      const script = windowsToastScript(title, body);
      const encoded = Buffer.from(script, "utf16le").toString("base64");
      try {
        execFileSync(
          windowsPowerShell(),
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
          {
            stdio: "ignore",
            windowsHide: true,
            timeout: 20_000,
          },
        );
        return true;
      } catch (direct) {
        // A task registered to run while logged off (S4U) lives in session 0,
        // which has no desktop: the toast always fails there and the user
        // never hears about a broken sync. Hand it to the signed-in session.
        if (notifyViaUserSession(script)) return true;
        throw direct;
      }
    }
    if (platform === "darwin") {
      execFileSync("/usr/bin/osascript", ["-e", appleScriptNotification(title, body)], {
        stdio: "ignore",
        timeout: 20_000,
      });
      return true;
    }
    execFileSync("notify-send", ["--app-name=opencode-sync", title, body], {
      stdio: "ignore",
      timeout: 20_000,
    });
    return true;
  } catch {
    return false;
  }
}
