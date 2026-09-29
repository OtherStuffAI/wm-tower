import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidates, ngitCommit, type Candidate } from './signing-policy-candidates';

// Only imports source functions. Never connects to a broker, signs, or loads a live store.
const autopilot = process.env.AUTOPILOT_REPO ?? `${process.env.HOME}/code/wm/autopilot`;
const ngit = process.env.NGIT_REPO ?? `${process.env.HOME}/code/ngit-poc/ngit`;
const { validateSigningPolicyDraft, SigningPolicyRegistry, FileSigningPolicyStore } =
  await import(`${autopilot}/src/signing/signing-policy-registry.ts`);
const { matchesExactNostrTags } = await import(`${autopilot}/src/signing/nostr-kind-policy.ts`);
const drafts = ['http', 'nostr'].map(name => JSON.parse(readFileSync(new URL(`./signing-policy-${name}.draft.json`, import.meta.url), 'utf8')));
const nostr = validateSigningPolicyDraft(drafts[1]);
// Structural checks from capability-broker.ts:1015-1062; exact matching uses its actual helper.
// This is candidate validation, not the broker HTTP/signing path.
function accepts(event: Candidate): boolean {
  const rule = nostr.nostrKindRules.find((r: any) => r.kind === event.kind);
  return !!rule && Buffer.byteLength(event.content) <= rule.maxContentBytes
    && event.tags.length <= rule.maxTags
    && event.tags.reduce((n, tag) => n + tag.reduce((m, value) => m + Buffer.byteLength(value), 0), 0) <= rule.maxTagBytes
    && event.tags.every(tag => rule.allowedTagNames.includes(tag[0]))
    && rule.requiredTags.every(([name, value]: string[]) => event.tags.some(tag => tag[0] === name && tag[1] === value))
    && matchesExactNostrTags(event.tags, rule.exactTags);
}
test('source pins and required emitted shapes remain reviewable', () => {
  const pin = JSON.parse(readFileSync(new URL('./versions.json', import.meta.url), 'utf8')).upstreams.find((u: any) => u.name === 'ngit');
  expect(pin.revision).toBe(ngitCommit);
  expect(Bun.spawnSync(['git', '-C', ngit, 'rev-parse', 'HEAD']).stdout.toString().trim()).toBe(pin.effective_revision ?? ngitCommit);
  expect(Bun.spawnSync(['git', '-C', ngit, 'merge-base', '--is-ancestor', ngitCommit, 'HEAD']).exitCode).toBe(0);
  expect(Bun.spawnSync(['git', '-C', ngit, 'diff', '--exit-code', ngitCommit, '--', 'src/lib/repo_state.rs', 'src/lib/event_ordering.rs', 'src/lib/login/user.rs']).exitCode).toBe(0);
  expect(Bun.spawnSync(['git', '-C', autopilot, 'merge-base', '--is-ancestor', '8143790', 'HEAD']).exitCode).toBe(0);
  const source = readFileSync(`${ngit}/src/lib/repo_ref.rs`, 'utf8');
  // URL compatibility and explicit private init changed; event emission did not.
  const base = Bun.spawnSync(['git', '-C', ngit, 'show', `${ngitCommit}:src/lib/repo_ref.rs`]).stdout.toString();
  const emission = (text: string) => {
    const start=text.indexOf('    pub async fn to_event(');
    const next=text.indexOf('\n    pub ',start+1);
    return text.slice(start,next);
  };
  expect(emission(source)).toBe(emission(base));
  expect(source).toContain('Tag::parse(["alt", &format!("git repository: {}", self.name)])');
  expect(source).toContain('Tag::parse(["private", "true"])');
  expect(source).toContain('self.maintainers.as_slice() == [public_key]');
});
test('disabled drafts normalize and persist exact arrays and conjunctive assignments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grasp-policy-unsigned-'));
  try {
    const store = new FileSigningPolicyStore(join(dir, 'policies.json'));
    const options = { forgejoCompletionUrl: 'https://example.invalid/authorize/complete' };
    const registry = new SigningPolicyRegistry(store, options);
    for (const draft of drafts) {
      const normalized = validateSigningPolicyDraft(draft);
      expect(normalized.enabled).toBe(false);
      expect(normalized.assignments).toEqual({
        profileIds: ['fd-npub1s46587g3k2axql224qz-2e5caefddd47ee874e8e5fc9-npub1hd37razr2rfxsw6dns5'],
        workspaceIds: ['2e5caefd-dd65-45d2-b747-ee874e8e5fc9'],
      });
      normalized.nostrKindRules.forEach((rule: any, i: number) => expect(rule.exactTags).toEqual(draft.nostrKindRules[i].exactTags));
      registry.create(normalized, 'unsigned-fixture');
    }
    const reloaded = new SigningPolicyRegistry(store, options);
    for (const draft of drafts) {
      expect(reloaded.get(draft.id)).toEqual(registry.get(draft.id));
      expect(reloaded.getHistory(draft.id)[0].snapshot.nostrKindRules).toEqual(validateSigningPolicyDraft(draft).nostrKindRules);
    }
    expect(reloaded.resolveReferences({ profileId: drafts[0].assignments.profileIds[0], workspaceId: drafts[0].assignments.workspaceIds[0] })).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('initial sole-author private announcement, main state and auth candidate pass', () => {
  candidates().forEach(event => expect(accepts(event)).toBe(true));
});
test('every exact tag rejects missing, wrong, duplicate, extra value and reordered duplicate', () => {
  for (const event of candidates()) {
    const rule = nostr.nostrKindRules.find((r: any) => r.kind === event.kind);
    for (const exact of rule.exactTags) {
      const without = event.tags.filter(tag => tag[0] !== exact[0]);
      for (const tags of [without, [...without, [exact[0], 'wrong']], [...event.tags, exact],
        [exact, ...event.tags], [[exact[0], "unapproved"], ...event.tags],
        [...event.tags, [exact[0], "unapproved"]], [...without, [...exact, 'https://public.invalid/']]]) {
        expect(accepts({ ...event, tags })).toBe(false);
      }
    }
  }
});
test('extra destinations, roles, publication tags, non-main state and nonce stay denied', () => {
  for (const event of candidates()) {
    for (const name of ['maintainers', 'M', 'm', 'o', 'u', 'blossoms', 't', '!', 'nonce', 'refs/heads/other']) {
      expect(accepts({ ...event, tags: [...event.tags, [name, 'unapproved']] })).toBe(false);
    }
  }
  const announcement = candidates()[1]!;
  expect(accepts({ ...announcement, tags: announcement.tags.map(t => t[0] === 'web' ? ['web', 'https://public.invalid/'] : t) })).toBe(false);
  for (const event of candidates()) {
    for (const name of ['relay', 'relays', 'clone']) {
      const tags = event.tags.map(t => t[0] === name ? [name, t[1]!.endsWith('/') ? t[1]!.slice(0, -1) : t[1]! + '/'] : t);
      if (event.tags.some(t => t[0] === name)) expect(accepts({ ...event, tags })).toBe(false);
    }
  }
  expect(accepts({ kind: 10318, content: 'unsigned encrypted-content placeholder', tags: [] })).toBe(false);
});
