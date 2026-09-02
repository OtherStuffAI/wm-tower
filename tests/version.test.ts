import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/server';

describe('Tower version', () => {
  const app = createApp();

  test('GET /version exposes build metadata without auth', async () => {
    const res = await app.request('/version');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.name).toBe('wingman-tower');
    expect(body.version).toBe('0.1.0');
    expect(typeof body.runtime).toBe('string');
  });
});
