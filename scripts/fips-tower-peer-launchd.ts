import { resolve } from 'node:path';

const xml = (text: string) => text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/** Render only. Installing this root LaunchDaemon is an explicit operator action. */
export function renderTowerFipsPeerPlist(fipsPath = '/usr/local/bin/fips', configPath = '/usr/local/etc/fips-tower/fips.yaml') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>studio.otherstuff.tower-fips-peer</string>
<key>ProgramArguments</key><array><string>${xml(fipsPath)}</string><string>--config</string><string>${xml(configPath)}</string></array>
<key>WorkingDirectory</key><string>${xml(resolve(configPath, '..'))}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>/var/log/tower-fips-peer.log</string>
<key>StandardErrorPath</key><string>/var/log/tower-fips-peer.error.log</string>
</dict></plist>\n`;
}

if (import.meta.main) process.stdout.write(renderTowerFipsPeerPlist());
