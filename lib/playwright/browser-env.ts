/**
 * The environment given to browser processes: Playwright's Chromium, Firefox and WebKit, and the Chrome that Lighthouse
 * starts. Left alone, a launched browser inherits the worker's whole environment (DATABASE_URL, SUPABASE_SECRET_KEY, …)
 * while it renders untrusted websites. Only what a browser needs to start, render and reach the network is passed on:
 * an allow-list of system paths, profile and temp folders, locale, display and font settings, and proxy settings.
 * Names are compared case-insensitively (Windows environment names are case-insensitive).
 */
const ALLOWED = new Set([
  // Executables and system folders
  "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "OS",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432", "PROGRAMDATA",
  "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  // User profile, home and temp folders
  "HOME", "USER", "LOGNAME", "USERNAME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PUBLIC",
  "TMPDIR", "TMP", "TEMP",
  // Locale and time zone
  "LANG", "LANGUAGE", "TZ",
  // Display and desktop session (Linux)
  "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS",
  // Network proxy, so tested sites stay reachable behind a proxy
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
]);
const ALLOWED_PREFIXES = ["LC_", "XDG_", "FONTCONFIG_"];

export function browserEnvironment(source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (ALLOWED.has(upper) || ALLOWED_PREFIXES.some((p) => upper.startsWith(p))) env[name] = value;
  }
  return env;
}
