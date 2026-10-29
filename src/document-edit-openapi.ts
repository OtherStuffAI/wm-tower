import { DOCUMENT_EDIT_PROTOCOL } from './types';
const workspace = {name:'workspaceId',in:'path',required:true,schema:{type:'string',format:'uuid'}};
const lease = {name:'leaseId',in:'path',required:true,schema:{type:'string',format:'uuid'}};
const failures = {'400':{description:'Invalid input'},'401':{description:'NIP-98 required'},'403':{description:'Write access required'},'409':{description:'edit_lease_held, edit_lease_changed, document_edit_session_superseded or lease_invalid. Drafts must be retained; no implicit takeover.'}};
export const documentEditPaths = {
  '/api/v4/flightdeck-pg/workspaces/{workspaceId}/edit-leases': {get:{
    tags:['Flight Deck PG'],security:[{nip98:[]}],summary:'Inspect editing authority without acquiring it',
    description:'Document responses advertise document_edit_session_v1. Lease inspection contains holder/id/expiry, never raw token or editor session. See docs/contract/document-edit-session-v1.md.',
    parameters:[workspace,{name:'entity_type',in:'query',required:true,schema:{type:'string',enum:['document','task','scope']}},{name:'entity_id',in:'query',required:true,schema:{type:'string',format:'uuid'}}],
    responses:{'200':{description:'Active lease or null; document_edit_protocol echoes negotiated document capability'},...failures},
  }},
  '/api/v4/flightdeck-pg/workspaces/{workspaceId}/edit-leases/acquire': {post:{
    tags:['Flight Deck PG'],security:[{nip98:[]}],summary:'Acquire an edit lease or explicitly take over a document on another device',
    description:'Document-only additive protocol. Legacy ordinary Save remains supported. Any active document lease blocks ordinary acquire, including same actor. Explicit same-actor takeover CAS checks expected_lease_id, revokes all prior document leases, and advances/snapshots row_version without changing content. It returns coherent post-barrier doc/canonical_version. Superseded editor sessions may never reacquire. Task/scope semantics unchanged. Clients must require protocol echo before enabling takeover.',
    parameters:[workspace],requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['entity_type','entity_id'],properties:{
      entity_type:{type:'string',enum:['document','task','scope']},entity_id:{type:'string',format:'uuid'},ttl_seconds:{type:'integer',minimum:30,maximum:600,default:120},
      document_edit_protocol:{type:'string',enum:[DOCUMENT_EDIT_PROTOCOL]},editor_session_id:{type:'string',format:'uuid',description:'Random stable UUID for this open editor. Must be fresh for explicit takeover; required with protocol.'},
      takeover:{type:'boolean',description:'Only a deliberate user action; same actor only.'},expected_lease_id:{type:'string',format:'uuid',description:'Required for takeover. Current observed lease must still match.'},
    }}}}},responses:{'201':{description:'Lease token and own editor_session_id; document_edit_protocol echoed only when requested. Document response includes current doc/canonical_version and taken_over.'},...failures},
  }},
  '/api/v4/flightdeck-pg/workspaces/{workspaceId}/edit-leases/{leaseId}/renew': {post:{
    tags:['Flight Deck PG'],security:[{nip98:[]}],summary:'Renew the exact unrevoked edit lease',parameters:[workspace,lease],
    requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['lease_token'],properties:{lease_token:{type:'string'},ttl_seconds:{type:'integer',minimum:30,maximum:600}}}}}},
    responses:{'200':{description:'Same authority renewed. Session-aware document leases echo protocol and own editor_session_id.'},...failures},
  }},
  '/api/v4/flightdeck-pg/workspaces/{workspaceId}/edit-leases/{leaseId}/release': {post:{
    tags:['Flight Deck PG'],security:[{nip98:[]}],summary:'Best-effort release of the exact lease token',parameters:[workspace,lease],
    requestBody:{required:true,content:{'application/json':{schema:{type:'object',required:['lease_token'],properties:{lease_token:{type:'string'}}}}}},
    responses:{'200':{description:'released boolean; a late release cannot release a successor lease'},...failures},
  }},
};
