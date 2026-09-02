# Agent Chat Phase 5 Measurements

Status: measured in Tower
Last updated: 2026-04-08

## Scope

This note records the phase 5 measurement used to justify the only Tower optimization shipped in WP18.

## Baseline Candidate Review

Measured and reviewed candidates:

- SSE family filtering
- actor-visible projection changes
- chat-focused stream hints
- SSE payload encoding cost

Result:

- no evidence yet justified changing the SSE contract or adding chat-specific stream semantics
- one internal hotspot was worth optimizing: repeated UTF-8 encoding of identical SSE payloads during fan-out and replay

## Measurement

Benchmark command used during WP18:

```bash
node -e "const {performance}=require('perf_hooks'); const payload='event: record-changed\\ndata: '+JSON.stringify({family_hash:'wingman-fd:chat_message',record_id:'r',version:1,updated_at:'2026-04-08T00:00:00.000Z'})+'\\n\\n'; const encoder=new TextEncoder(); const clients=50; const events=10000; let t0=performance.now(); for(let i=0;i<events;i++){ for(let j=0;j<clients;j++){ encoder.encode(payload); } } let t1=performance.now(); const encoded=encoder.encode(payload); let t2=performance.now(); for(let i=0;i<events;i++){ for(let j=0;j<clients;j++){ void encoded; } } let t3=performance.now(); console.log(JSON.stringify({per_client_encode_ms:+(t1-t0).toFixed(2), reuse_preencoded_ms:+(t3-t2).toFixed(2), payload_bytes:encoded.length, operations:events*clients}, null, 2));"
```

Observed result in this repo session:

```json
{
  "per_client_encode_ms": 193.8,
  "reuse_preencoded_ms": 2.3,
  "payload_bytes": 139,
  "operations": 500000
}
```

Interpretation:

- repeated per-client encoding is materially more expensive than reusing pre-encoded bytes
- this is a real Tower runtime cost because the same advisory payload is sent to multiple SSE clients and may be replayed later
- the optimization is internal only and does not change event visibility, payload shape, replay semantics, or routing contracts

## Optimization Shipped

- `src/sse-hub.ts` now encodes each payload once per emitted event
- fan-out reuses the same `Uint8Array`
- replay reuses the buffered encoded bytes rather than re-encoding stored strings

## Deferred

Still deferred due to lack of measurement:

- SSE family filtering
- chat-focused stream hints
- structured reference support
- any change to actor-visible projection rules
