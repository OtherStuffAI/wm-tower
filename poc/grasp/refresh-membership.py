#!/usr/bin/env python3
"""Refresh the explicit workspace snapshot; never read signing keys or restart services."""
import datetime
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent
WORKSPACE = '2e5caefd-dd65-45d2-b747-ee874e8e5fc9'
APP = 'npub1hd37reqgfcnz3pvzj4grknd2nkzc94p9ercmunrxx22razr2rfxsw6dns5'
OWNER = 'npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy'
SERVICE = 'npub1995l838tl29llpxwvpdv6hc66cttrt6hrr8xyeq7kmdqevkeyk0qwvfxlc'

def main():
    command = ['bun', 'clis/wingman.ts', 'flightdeck', 'members', 'list',
               '--tower-url', 'https://sb4.otherstuff.studio', '--app-npub', APP,
               '--workspace', WORKSPACE, '--bot-crypto', '--json']
    result = json.loads(subprocess.check_output(command,
        cwd=os.environ.get('AUTOPILOT_REPO', '/Users/mini/code/wm/autopilot'), timeout=30))
    identity = result['identity']
    expected = {'workspace_id': WORKSPACE, 'app_npub': APP,
                'workspace_owner_npub': OWNER, 'workspace_service_npub': SERVICE}
    if any(identity.get(k) != v for k, v in expected.items()):
        raise RuntimeError('Workspace binding changed; snapshot was not updated')
    if result.get('next_cursor') or result.get('has_more'):
        raise RuntimeError('Incomplete member page; snapshot was not updated')
    members = sorted({entry['actor']['npub'] for entry in result['members']})
    if not members or OWNER not in members or any(
        not re.fullmatch(r'npub1[023456789acdefghjklmnpqrstuvwxyz]{58}', m) for m in members
    ):
        raise RuntimeError('Invalid member list; snapshot was not updated')
    env_path = ROOT / 'local.env'
    # This file contains only PoC public routing and npubs, never credentials.
    lines = env_path.read_text().splitlines()
    if sum(line.startswith('GRASP_PRIVATE_MEMBERS=') for line in lines) != 1:
        raise RuntimeError('Expected exactly one GRASP_PRIVATE_MEMBERS setting')
    updated = '\n'.join('GRASP_PRIVATE_MEMBERS=' + ','.join(members)
        if line.startswith('GRASP_PRIVATE_MEMBERS=') else line for line in lines) + '\n'
    result['captured_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    temporary = env_path.with_suffix('.env.tmp')
    temporary.write_text(updated)
    os.chmod(temporary, 0o600)
    temporary.replace(env_path)
    (ROOT / 'membership.json').write_text(json.dumps(result, indent=2) + '\n')
    print(f'Snapshotted {len(members)} members; service is unchanged until the documented recreation.')

if __name__ == '__main__':
    main()
