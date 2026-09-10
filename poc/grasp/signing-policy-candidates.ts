// Unsigned expectations of ngit c2cc591d, not captured signer output.
// repo_ref.rs:940-1089; repo_state.rs:54-75; event_ordering.rs:175-181.
export const ngitCommit = 'c2cc591dcfae5d46dc178c0ea87e8bc1802f09b3';
export const relay = 'ws://npub109684nue495hq240u3dqzyf2kltk23u3mqkk9l44ga6szed4jcysramf74.fips:41007/';
export const clone = 'http://npub109684nue495hq240u3dqzyf2kltk23u3mqkk9l44ga6szed4jcysramf74.fips:41007/npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr/synthetic.git';
export const oid = '1234567890abcdef1234567890abcdef12345678'; // synthetic, no Git objects
export type Candidate = { kind: number; content: string; tags: string[][] };
export function candidates(): Candidate[] {
  // RepoRef: identifier/name synthetic, private=true, sole maintainer signer Rick;
  // empty web/hashtags/upstream/blossoms/roles/moderators/extra_tags/events; no lead.
  // Explicit slash in RelayUrl input; clone remains a literal String.
  return [
    { kind: 22242, content: '', tags: [['relay', relay], ['challenge', 'unsigned-fixture']] },
    { kind: 30617, content: '', tags: [
      ['d', 'synthetic'], ['r', oid, 'euc'], ['name', 'synthetic'],
      ['description', 'Synthetic private PoC'], ['clone', clone], ['web'],
      ['relays', relay], ['alt', 'git repository: synthetic'], ['private', 'true'],
    ] },
    { kind: 30618, content: '', tags: [
      ['d', 'synthetic'], ['HEAD', 'ref: refs/heads/main'], ['refs/heads/main', oid],
    ] },
  ];
}
