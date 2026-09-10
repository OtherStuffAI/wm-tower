import {test,expect} from 'bun:test';
import {validateSignedResponse,safeBrokerError} from './signed-response';
const autopilot = process.env.AUTOPILOT_REPO ?? '/Users/mini/code/wm/autopilot';
const {generateSecretKey, finalizeEvent, verifyEvent} = await import(`${autopilot}/node_modules/nostr-tools/lib/esm/index.js`);
// Disposable test-only key, no broker, persistence or publication.
const key = generateSecretKey();
const template = {kind:27235,created_at:100,content:'',tags:[['u','http://test.invalid/synthetic.git'],['method','GET']]};
const event = finalizeEvent(template,key);
const expected = {...template,pubkey:event.pubkey};
test('accepts valid exact signed response and bounded broker time',()=>{
  expect(()=>validateSignedResponse(event,expected,verifyEvent)).not.toThrow();
  expect(()=>validateSignedResponse(finalizeEvent({...template,created_at:105},key),expected,verifyEvent)).not.toThrow();
});
test('rejects valid signatures for changed fields, actor and out-of-window timestamps',()=>{
  for(const patch of [{kind:1},{content:'changed'},{tags:[['u','http://other.invalid']]},{created_at:99},{created_at:106}]) {
    expect(()=>validateSignedResponse(finalizeEvent({...template,...patch},key),expected,verifyEvent)).toThrow();
  }
  expect(()=>validateSignedResponse(finalizeEvent(template,generateSecretKey()),expected,verifyEvent)).toThrow();
});
test('rejects malformed output and invalid signatures',()=>{
  expect(()=>validateSignedResponse(null,expected,verifyEvent)).toThrow();
  // JSON copy avoids the verifier cache symbol on an already verified event.
  expect(()=>validateSignedResponse({...JSON.parse(JSON.stringify(event)),sig:'0'.repeat(128)},expected,verifyEvent)).toThrow();
});
test('HTTP custody tag must bind the current session and remain signed',()=>{
  const custody=['wm-session-capability','12345678-1234-1234-1234-123456789abc','test-session','a'.repeat(64)];
  const signed=finalizeEvent({...template,tags:[...template.tags,custody]},key);
  expect(()=>validateSignedResponse(signed,expected,verifyEvent,'test-session')).not.toThrow();
  expect(()=>validateSignedResponse(signed,expected,verifyEvent,'other-session')).toThrow();
  expect(()=>validateSignedResponse(finalizeEvent({...template,tags:[...template.tags,custody,custody]},key),expected,verifyEvent,'test-session')).toThrow();
});
test('unexpected broker errors cannot echo sensitive data',()=>{
  expect(safeBrokerError(new Error('sentinel-secret-123'))).toBe('Broker request failed (details redacted)');
  expect(safeBrokerError(new Error('Capability does not allow this operation'))).toBe('Capability does not allow this operation');
});
