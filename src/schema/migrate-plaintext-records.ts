import { generateSecretKey, getPublicKey, nip19, nip44 } from 'nostr-tools';
import { ensureServiceIdentity } from '../service-identity';
import { getDb, closeDb } from '../db';
import { ensureRuntimeSchema } from './ensure-runtime-schema';

type GroupRow = {
  id: string;
  owner_npub: string;
  name: string;
  group_npub: string | null;
};

type MemberRow = {
  group_id: string;
  member_npub: string;
};

type RecordRow = {
  id: string;
  record_id: string;
  owner_npub: string;
  owner_ciphertext: string;
};

type GroupPayloadRow = {
  id: string;
  group_npub: string;
  ciphertext: string;
};

type CiphertextEnvelope = {
  encrypted_by_npub: string;
  ciphertext: string;
};

function requiredArg(name: string): string {
  const prefix = `--${name}=`;
  const inline = Bun.argv.find((arg) => arg.startsWith(prefix));
  const index = Bun.argv.indexOf(`--${name}`);
  const value = inline?.slice(prefix.length) || (index >= 0 ? Bun.argv[index + 1] : undefined);
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

const legacyPeerNpub = requiredArg('legacy-peer-npub');
if (!isValidNpub(legacyPeerNpub)) throw new Error('--legacy-peer-npub must be a valid npub');

function decodeNsec(value: string) {
  const decoded = nip19.decode(value);
  if (decoded.type !== 'nsec' || !(decoded.data instanceof Uint8Array)) {
    throw new Error('Invalid nsec');
  }
  return decoded.data;
}

function decodeNpub(value: string) {
  const decoded = nip19.decode(value);
  if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
    throw new Error(`Invalid npub: ${value}`);
  }
  return decoded.data;
}

function isValidNpub(value: string) {
  try {
    decodeNpub(value);
    return true;
  } catch {
    return false;
  }
}

function createGroupIdentity() {
  const secret = generateSecretKey();
  const pubkeyHex = getPublicKey(secret);
  return {
    secret,
    nsec: nip19.nsecEncode(secret),
    npub: nip19.npubEncode(pubkeyHex),
    pubkeyHex,
  };
}

function wrapForRecipient(senderSecret: Uint8Array, recipientNpub: string, plaintext: string) {
  return nip44.encrypt(plaintext, nip44.getConversationKey(senderSecret, decodeNpub(recipientNpub)));
}

function unwrapForRecipient(senderSecret: Uint8Array, recipientNpub: string, ciphertext: string) {
  return nip44.decrypt(ciphertext, nip44.getConversationKey(senderSecret, decodeNpub(recipientNpub)));
}

function encryptForGroup(groupSecret: Uint8Array, groupNpub: string, plaintext: string) {
  return nip44.encrypt(plaintext, nip44.getConversationKey(groupSecret, decodeNpub(groupNpub)));
}

function parseJson(value: string) {
  if (!String(value || '').trim().startsWith('{')) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseCiphertextEnvelope(value: string): CiphertextEnvelope | null {
  const parsed = parseJson(value);
  if (
    parsed
    && typeof parsed === 'object'
    && typeof parsed.encrypted_by_npub === 'string'
    && typeof parsed.ciphertext === 'string'
  ) {
    return parsed as CiphertextEnvelope;
  }
  return null;
}

function isStructuredPayload(value: unknown): value is {
  app_namespace: string;
  collection_space: string;
  schema_version: number;
  record_id: string;
  data: Record<string, unknown>;
} {
  return !!(
    value
    && typeof value === 'object'
    && typeof (value as Record<string, unknown>).app_namespace === 'string'
    && typeof (value as Record<string, unknown>).collection_space === 'string'
    && typeof (value as Record<string, unknown>).record_id === 'string'
    && typeof (value as Record<string, unknown>).data === 'object'
  );
}

function parseStructuredPayloadJson(value: string) {
  const parsed = parseJson(value);
  return isStructuredPayload(parsed) ? parsed : null;
}

function normalizeOwnerPayload(ownerCiphertext: string, ownerNpub: string) {
  let current = ownerCiphertext;
  let envelopeDepth = 0;

  for (let depth = 0; depth < 4; depth++) {
    const envelope = parseCiphertextEnvelope(current);
    if (!envelope) break;
    if (envelope.encrypted_by_npub !== serviceNpub || !isValidNpub(ownerNpub)) {
      return { plaintextPayload: null, normalizedCiphertext: current, changed: envelopeDepth > 1 };
    }
    envelopeDepth += 1;
    current = unwrapForRecipient(serviceSecret, ownerNpub, envelope.ciphertext);
  }

  const plaintextPayload = parseStructuredPayloadJson(current);
  if (!plaintextPayload) {
    return { plaintextPayload: null, normalizedCiphertext: ownerCiphertext, changed: false };
  }

  if (envelopeDepth === 1) {
    return {
      plaintextPayload,
      normalizedCiphertext: ownerCiphertext,
      changed: false,
    };
  }

  const normalizedCiphertext = JSON.stringify({
    encrypted_by_npub: serviceNpub,
    ciphertext: wrapForRecipient(serviceSecret, ownerNpub, JSON.stringify(plaintextPayload)),
  });

  return {
    plaintextPayload,
    normalizedCiphertext,
    changed: normalizedCiphertext !== ownerCiphertext || unwrapped,
  };
}

const serviceIdentity = await ensureServiceIdentity();
const serviceSecret = decodeNsec(serviceIdentity.nsec);
const serviceNpub = serviceIdentity.npub;
const sql = getDb();

await ensureRuntimeSchema();

const groups = await sql<GroupRow[]>`
  SELECT id, owner_npub, name, group_npub
  FROM v4_groups
  ORDER BY created_at ASC
`;

const members = await sql<MemberRow[]>`
  SELECT group_id, member_npub
  FROM v4_group_members
`;

const memberMap = new Map<string, string[]>();
for (const member of members) {
  const list = memberMap.get(member.group_id) || [];
  list.push(member.member_npub);
  memberMap.set(member.group_id, list);
}

const groupSecrets = new Map<string, { groupId: string; groupNpub: string; secret: Uint8Array }>();
let groupsBackfilled = 0;
let wrappedKeysInserted = 0;
let invalidMemberNpubsSkipped = 0;
let invalidOwnerNpubsSkipped = 0;

for (const group of groups) {
  const identity = group.group_npub
    ? null
    : createGroupIdentity();
  const groupNpub = group.group_npub || identity?.npub;
  const groupSecret = identity?.secret || null;

  if (!group.group_npub && groupNpub) {
    await sql`
      UPDATE v4_groups
      SET group_npub = ${groupNpub}
      WHERE id = ${group.id}
    `;
    group.group_npub = groupNpub;
    groupsBackfilled++;
  }

  const memberNpubs = [...new Set(memberMap.get(group.id) || [group.owner_npub])];
  const activeKeyCount = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int as count
    FROM v4_group_member_keys
    WHERE group_id = ${group.id}
      AND revoked_at IS NULL
  `;

  let resolvedSecret = groupSecret;
  if (!resolvedSecret && activeKeyCount[0]?.count > 0) {
    const [existingKey] = await sql<{ member_npub: string; wrapped_group_nsec: string; wrapped_by_npub: string }[]>`
      SELECT member_npub, wrapped_group_nsec, wrapped_by_npub
      FROM v4_group_member_keys
      WHERE group_id = ${group.id}
        AND revoked_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1
    `;

    if (existingKey && existingKey.wrapped_by_npub === serviceNpub && isValidNpub(existingKey.member_npub)) {
      try {
        resolvedSecret = decodeNsec(
          unwrapForRecipient(serviceSecret, existingKey.member_npub, existingKey.wrapped_group_nsec)
        );
      } catch {
        resolvedSecret = null;
      }
    }
  }

  if (!resolvedSecret) {
    const regenerated = createGroupIdentity();
    if (!group.group_npub) {
      resolvedSecret = regenerated.secret;
    } else {
      resolvedSecret = regenerated.secret;
      const regeneratedNpub = regenerated.npub;
      await sql`
        UPDATE v4_groups
        SET group_npub = ${regeneratedNpub}
        WHERE id = ${group.id}
      `;
      group.group_npub = regeneratedNpub;
    }
  }

  const finalGroupNpub = group.group_npub || groupNpub;
  if (!finalGroupNpub || !resolvedSecret) continue;
  groupSecrets.set(group.id, { groupId: group.id, groupNpub: finalGroupNpub, secret: resolvedSecret });

  for (const memberNpub of memberNpubs) {
    if (!isValidNpub(memberNpub)) {
      invalidMemberNpubsSkipped++;
      continue;
    }
    const wrapped = wrapForRecipient(serviceSecret, memberNpub, nip19.nsecEncode(resolvedSecret));
    await sql`
      INSERT INTO v4_group_member_keys (
        group_id,
        member_npub,
        wrapped_group_nsec,
        wrapped_by_npub,
        approved_by_npub,
        key_version
      )
      VALUES (
        ${group.id},
        ${memberNpub},
        ${wrapped},
        ${serviceNpub},
        ${group.owner_npub},
        1
      )
      ON CONFLICT (group_id, member_npub, key_version) DO NOTHING
    `;
    wrappedKeysInserted++;
  }
}

const groupsById = new Map(groups.map((group) => [group.id, group]));
const groupsByNpub = new Map(groups.filter((group) => group.group_npub).map((group) => [group.group_npub as string, group]));
const directPeerGroupByOwner = new Map<string, { groupId: string; groupNpub: string; secret: Uint8Array }>();

for (const group of groups) {
  const membersForGroup = new Set(memberMap.get(group.id) || []);
  const hasPeer = membersForGroup.has(legacyPeerNpub);
  const hasOnlyOwnerAndPeer = membersForGroup.size === 2 && membersForGroup.has(group.owner_npub) && hasPeer;
  if (!hasOnlyOwnerAndPeer) continue;
  const secret = groupSecrets.get(group.id);
  if (!secret) continue;
  const existing = directPeerGroupByOwner.get(group.owner_npub);
  if (!existing) {
    directPeerGroupByOwner.set(group.owner_npub, secret);
  }
}

const orphanPlaintextGroupRows = await sql<{
  group_npub: string;
  owner_npub: string;
  ciphertext: string;
}[]>`
  SELECT rgp.group_npub, r.owner_npub, rgp.ciphertext
  FROM v4_record_group_payloads rgp
  JOIN v4_records r ON r.id = rgp.record_row_id
  WHERE rgp.ciphertext LIKE '{"app_namespace"%'
`;

const remappedLegacyGroupRefs = new Set<string>();
for (const row of orphanPlaintextGroupRows) {
  const plaintext = parseStructuredPayloadJson(row.ciphertext);
  if (!plaintext) continue;
  const peerGroup = directPeerGroupByOwner.get(row.owner_npub);
  if (!peerGroup) continue;
  const haystack = JSON.stringify(plaintext);
  if (haystack.includes(legacyPeerNpub)) {
    remappedLegacyGroupRefs.add(`${row.owner_npub}|${row.group_npub}`);
  }
}

const records = await sql<RecordRow[]>`
  SELECT id, record_id, owner_npub, owner_ciphertext
  FROM v4_records
  ORDER BY updated_at ASC
`;

let ownerPayloadsMigrated = 0;
let groupPayloadsMigrated = 0;
let groupRefsUpdated = 0;

for (const record of records) {
  let ownerCiphertext = record.owner_ciphertext;
  let recordChanged = false;

  if (isValidNpub(record.owner_npub)) {
    const normalizedOwner = normalizeOwnerPayload(record.owner_ciphertext, record.owner_npub);
    if (normalizedOwner.plaintextPayload && normalizedOwner.changed) {
      ownerCiphertext = normalizedOwner.normalizedCiphertext;
      ownerPayloadsMigrated++;
      recordChanged = true;
    }
  } else {
    invalidOwnerNpubsSkipped++;
  }

  const groupPayloads = await sql<GroupPayloadRow[]>`
    SELECT id, group_npub, ciphertext
    FROM v4_record_group_payloads
    WHERE record_row_id = ${record.id}
  `;

  for (const payload of groupPayloads) {
    const plaintext = parseStructuredPayloadJson(payload.ciphertext);
    let group =
      groupsById.get(payload.group_npub)
      || groupsByNpub.get(payload.group_npub)
      || null;
    let groupSecret = group ? groupSecrets.get(group.id) : null;

    if (!groupSecret && remappedLegacyGroupRefs.has(`${record.owner_npub}|${payload.group_npub}`)) {
      groupSecret = directPeerGroupByOwner.get(record.owner_npub) || null;
      if (groupSecret) {
        group = groupsByNpub.get(groupSecret.groupNpub) || null;
      }
    }

    const nextGroupNpub = group?.group_npub || payload.group_npub;
    const nextCiphertext = plaintext && groupSecret
      ? encryptForGroup(groupSecret.secret, groupSecret.groupNpub, JSON.stringify(plaintext))
      : payload.ciphertext;

    if (nextGroupNpub !== payload.group_npub || nextCiphertext !== payload.ciphertext) {
      await sql`
        UPDATE v4_record_group_payloads
        SET group_npub = ${nextGroupNpub},
            ciphertext = ${nextCiphertext}
        WHERE id = ${payload.id}
      `;
      if (nextGroupNpub !== payload.group_npub) groupRefsUpdated++;
      if (nextCiphertext !== payload.ciphertext) groupPayloadsMigrated++;
      recordChanged = true;
    }
  }

  if (recordChanged) {
    await sql`
      UPDATE v4_records
      SET owner_ciphertext = ${ownerCiphertext},
          updated_at = now()
      WHERE id = ${record.id}
    `;
  }
}

console.log(JSON.stringify({
  groups_total: groups.length,
  groups_backfilled: groupsBackfilled,
  wrapped_keys_inserted: wrappedKeysInserted,
  invalid_member_npubs_skipped: invalidMemberNpubsSkipped,
  invalid_owner_npubs_skipped: invalidOwnerNpubsSkipped,
  owner_payloads_migrated: ownerPayloadsMigrated,
  group_payloads_migrated: groupPayloadsMigrated,
  group_refs_updated: groupRefsUpdated,
}, null, 2));

await closeDb();
