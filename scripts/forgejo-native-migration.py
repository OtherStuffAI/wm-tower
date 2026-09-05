#!/usr/bin/env python3
"""Reviewed rollout utility. No mutation without --apply. Never emits credentials."""
import argparse
import datetime
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

RETIRED = ('git-org-reconciler', 'git-identity-reconciler', 'git-issue-broker', 'git-reconciler')
REPOS = ('other-stuff/wapp-kindling', 'other-stuff/kindlingapi')


def docker(*args):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError('Docker operation failed: ' + ' '.join(args[:2]))
    return result.stdout.strip()


def writer_state(mode, names):
    result = []
    for name in names:
        if mode == 'swarm':
            data = json.loads(docker('service', 'inspect', name))[0]
            replicas = data['Spec'].get('Mode', {}).get('Replicated', {}).get('Replicas')
            if replicas is None:
                raise RuntimeError('Expected replicated service: ' + name)
            tasks = [json.loads(line) for line in docker('service', 'ps', '--no-trunc', '--format', '{{json .}}', name).splitlines() if line]
            active = [t for t in tasks if not t['CurrentState'].lower().startswith(('shutdown', 'complete', 'failed', 'rejected', 'remove'))]
            result.append({'name': name, 'replicas': replicas, 'active_tasks': active})
        else:
            data = json.loads(docker('inspect', name))[0]
            result.append({'name': name, 'running': data['State']['Running'], 'restart': data['HostConfig']['RestartPolicy']['Name'], 'image': data['Image']})
    return result


def stopped(state, mode):
    return all((r['replicas'] == 0 and not r['active_tasks']) if mode == 'swarm' else (not r['running'] and r['restart'] == 'no') for r in state)


def write_json(path, value):
    # Exclusive creation preserves previous proof and avoids following a symlink.
    with open(path, 'x', encoding='utf-8') as output:
        os.chmod(path, 0o600)
        json.dump(value, output, indent=2)
        output.write('\n')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def native_api(origin, token_file):
    url = urllib.parse.urlsplit(origin)
    if url.scheme != 'https' or not url.netloc or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
        raise RuntimeError('Forgejo origin must be an exact HTTPS origin without credentials')
    token_path = Path(token_file)
    if token_path.is_symlink() or not stat.S_ISREG(token_path.stat().st_mode) or token_path.stat().st_mode & 0o077:
        raise RuntimeError('Management token must be a private regular file (0600)')
    token = token_path.read_text().strip()
    if not token or any(c.isspace() for c in token):
        raise RuntimeError('Invalid management token file')
    opener = urllib.request.build_opener(NoRedirect())

    def request(path, method='GET', body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(origin.rstrip('/') + '/api/v1' + path, data=data, method=method,
                                     headers={'Authorization': 'token ' + token, 'Content-Type': 'application/json'})
        try:
            with opener.open(req, timeout=30) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'Native API {method} {path}: HTTP {error.code}') from None
    return request


def snapshot(api):
    result = {'user': api('/users/lara'), 'repositories': {}}
    for repo in REPOS:
        base = '/repos/' + repo
        # Explicit pagination avoids silently incomplete collaborator/team evidence.
        def pages(path):
            rows = []
            for page in range(1, 10001):
                batch = api(path + f'?limit=50&page={page}')
                rows.extend(batch)
                if not batch:
                    return rows
            raise RuntimeError('Native snapshot pagination exceeded bound')
        result['repositories'][repo] = {
            'repository': api(base), 'collaborators': pages(base + '/collaborators'),
            # Stock Forgejo 16 returns complete lists here; these routes do not paginate.
            'teams': api(base + '/teams'), 'branch_protections': api(base + '/branch_protections'),
            'lara_permission': api(base + '/collaborators/lara/permission'),
        }
    result['teams'] = []
    for page in range(1, 10001):
        teams = api('/orgs/other-stuff/teams?limit=50&page=' + str(page))
        for team in teams:
            members = []
            for member_page in range(1, 10001):
                batch = api('/teams/' + str(team['id']) + '/members?limit=50&page=' + str(member_page))
                members.extend(batch)
                if not batch:
                    break
            else:
                raise RuntimeError('Team member pagination exceeded bound')
            result['teams'].append({'team': team, 'members': members})
        if not teams:
            break
    else:
        raise RuntimeError('Team pagination exceeded bound')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['writers', 'native-snapshot', 'restore-lara'])
    parser.add_argument('--mode', choices=['swarm', 'compose'], default='swarm')
    parser.add_argument('--writer', action='append', default=[], help='Exact retired service/container name; repeat for ALL discovered writers')
    parser.add_argument('--output', required=True, help='New protected evidence JSON path')
    parser.add_argument('--apply', action='store_true', help='Explicitly execute authorized stop or one-time native Write remediation')
    parser.add_argument('--forgejo-origin')
    parser.add_argument('--management-token-file')
    args = parser.parse_args()
    os.umask(0o077)
    if Path(args.output).exists():
        raise RuntimeError('Evidence output already exists')
    if args.operation in ('writers', 'restore-lara'):
        if not args.writer or not any('org' in n for n in args.writer) or not any('identity' in n for n in args.writer):
            raise RuntimeError('Supply all discovered writers, including org and identity services')
        if any(not any(role in name for role in RETIRED) for name in args.writer):
            raise RuntimeError('Refusing a non-retired service/container name')
        before = writer_state(args.mode, args.writer)
        if args.operation == 'writers':
            if args.apply:
                for name in args.writer:
                    if args.mode == 'swarm':
                        docker('service', 'scale', name + '=0')
                    else:
                        docker('update', '--restart=no', name)
                        docker('stop', name)
                deadline = time.monotonic() + 120
                while True:
                    after = writer_state(args.mode, args.writer)
                    if stopped(after, args.mode):
                        break
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Writer tasks did not stop; do not cut over')
                    time.sleep(2)
            else:
                after = before
            write_json(args.output, {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'mode': args.mode, 'before': before, 'after': after, 'stopped': stopped(after, args.mode)})
            print('Writer evidence saved; stopped=' + str(stopped(after, args.mode)).lower())
            return
        if not stopped(before, args.mode):
            raise RuntimeError('Writers are not stopped; native permissions must not be changed')
    if not args.forgejo_origin or not args.management_token_file:
        raise RuntimeError('Native operation requires origin and private management-token file')
    api = native_api(args.forgejo_origin, args.management_token_file)
    evidence = snapshot(api)
    if args.operation == 'restore-lara':
        user = evidence['user']
        if user.get('id') != 8 or user.get('login') != 'lara' or user.get('is_admin'):
            raise RuntimeError('Lara account identity mismatch or unexpected admin privilege')
        if args.apply:
            write_json(args.output + '.before.json', {'native': evidence, 'writers': before})
            for repo in REPOS:
                api('/repos/' + repo + '/collaborators/lara', 'PUT', {'permission': 'write'})
            after = snapshot(api)
            for row in after['repositories'].values():
                if row['lara_permission'].get('permission') != 'write':
                    raise RuntimeError('Native Lara effective Write verification failed')
            for repo in REPOS:
                if after['repositories'][repo]['branch_protections'] != evidence['repositories'][repo]['branch_protections']:
                    raise RuntimeError('Branch protection changed concurrently; review snapshot')
            evidence = {'before': evidence, 'after': after, 'writer_proof': writer_state(args.mode, args.writer)}
            if not stopped(evidence['writer_proof'], args.mode):
                raise RuntimeError('Writer restarted during remediation; stop rollout')
    write_json(args.output, evidence)
    print('Native evidence saved. No agent-runtime success is implied.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print('Migration stopped: ' + str(error), file=sys.stderr)
        sys.exit(1)
