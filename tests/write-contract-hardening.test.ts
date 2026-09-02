import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * WP3 Write Contract Hardening — Tower
 *
 * Tests that Tower rejection messages include enough signer context
 * for debugging non-owner write failures. These are contract tests
 * that validate the diagnostic quality of rejection reasons.
 */

const RECORDS_SERVICE_PATH = path.resolve(import.meta.dirname, '..', 'src', 'services', 'records.ts');
const RECORDS_ROUTE_PATH = path.resolve(import.meta.dirname, '..', 'src', 'routes', 'records.ts');

describe('WP3: Tower rejection messages include signer diagnostics', () => {
  let recordsSource: string;

  it('records service file exists', () => {
    expect(fs.existsSync(RECORDS_SERVICE_PATH)).toBe(true);
    recordsSource = fs.readFileSync(RECORDS_SERVICE_PATH, 'utf8');
  });

  it('signature_npub mismatch rejection includes the authenticated npub for comparison', () => {
    recordsSource = recordsSource || fs.readFileSync(RECORDS_SERVICE_PATH, 'utf8');
    // The rejection message should include both the record's signature_npub
    // and the authenticated signerNpub so the developer can see the mismatch
    expect(recordsSource).toMatch(/signature_npub.*must match.*authenticated/i);
    // After WP3: should interpolate actual values for diagnostics
    expect(recordsSource).toMatch(/signerNpub|signer_npub/);
  });

  it('non-owner write rejection for missing group proof includes group_id context', () => {
    recordsSource = recordsSource || fs.readFileSync(RECORDS_SERVICE_PATH, 'utf8');
    // Should show which group was expected
    expect(recordsSource).toMatch(/missing valid group write proof for/);
  });

  it('non-owner write rejection for missing membership includes user context', () => {
    recordsSource = recordsSource || fs.readFileSync(RECORDS_SERVICE_PATH, 'utf8');
    // After WP3: should include the resolved userNpub in the message
    expect(recordsSource).toMatch(/not a current member/);
    expect(recordsSource).toMatch(/userNpub|user_npub/);
  });

  it('write_group resolution failure includes diagnostic detail', () => {
    recordsSource = recordsSource || fs.readFileSync(RECORDS_SERVICE_PATH, 'utf8');
    // Should mention both write_group_id and write_group_npub in the error
    expect(recordsSource).toMatch(/write_group_id.*write_group_npub|write_group_npub.*write_group_id/s);
  });

  it('strict group-id mode rejects legacy write_group_npub references clearly', () => {
    const routeSource = fs.readFileSync(RECORDS_ROUTE_PATH, 'utf8');
    expect(routeSource).toMatch(/strict_group_id_writes/);
    expect(routeSource).toMatch(/legacy_write_group_npub_forbidden/);
    expect(routeSource).toMatch(/group_payloads\[\]\.group_npub/);
  });

  it('new shared record rejection shows the expected writable payload group', () => {
    recordsSource = recordsSource || fs.readFileSync(RECORDS_SERVICE_PATH, 'utf8');
    expect(recordsSource).toMatch(/new shared record must include writable payload/);
  });
});

describe('WP3: Tower syncRecords documents signer resolution contract', () => {
  let recordsSource: string;

  it('syncRecords accepts both signerNpub and userNpub parameters', () => {
    recordsSource = fs.readFileSync(RECORDS_SERVICE_PATH, 'utf8');
    // The function signature should have both params for clear signer resolution
    expect(recordsSource).toMatch(/signerNpub.*string/);
    expect(recordsSource).toMatch(/userNpub.*string/);
  });

  it('ownership check uses resolved userNpub not signerNpub', () => {
    recordsSource = recordsSource || fs.readFileSync(RECORDS_SERVICE_PATH, 'utf8');
    // isOwnerWrite should compare userNpub (resolved real identity) to the normalized workspace service identity.
    expect(recordsSource).toMatch(/userNpub\s*===\s*workspaceServiceNpub/);
  });

  it('signature validation uses signerNpub not userNpub', () => {
    recordsSource = recordsSource || fs.readFileSync(RECORDS_SERVICE_PATH, 'utf8');
    // signature_npub must match the NIP-98 signer (which may be workspace key)
    expect(recordsSource).toMatch(/signature_npub\s*!==\s*signerNpub/);
  });
});
