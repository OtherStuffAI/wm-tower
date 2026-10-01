/** Numbered source implementation; does not indicate deployment or activation. */
export const FEED_READER_SOURCE_BUILD = 1;
const uuid = {type:'string',format:'uuid'};
const ref=(name:string)=>({$ref:`#/components/schemas/${name}`});
const version={type:'integer',minimum:0,maximum:2147483646};
const mutation={mutation_id:uuid,expected_row_version:version};
const flags={read:{type:'boolean'},dismissed:{type:'boolean'},saved:{type:'boolean'}};
export const feedReaderSchemas = {
  FeedSource:{oneOf:[
    {type:'object',additionalProperties:false,required:['kind','autopilot_connection_id','installation_id','feed_id','endpoint','format'],properties:{
      kind:{const:'wapp'},autopilot_connection_id:uuid,installation_id:uuid,feed_id:{type:'string',pattern:'^[a-z0-9][a-z0-9_-]{0,63}$',description:'list is reserved'},
      endpoint:{type:'string',description:'Exactly /feed/<feed_id>; registry-bound by reader before fetch'},format:{const:'jsonfeed-1.1'}}},
    {type:'object',additionalProperties:false,required:['kind','url','format'],properties:{kind:{const:'public'},url:{type:'string',format:'uri',maxLength:4096,description:'HTTP(S), no userinfo, fragment removed; preserve query order'},format:{enum:['jsonfeed-1.1','rss']}}}
  ]},
  FeedSubscription:{type:'object',required:['schema_version','id','workspace_id','reader_actor_id','source','title','status','row_version','created_at','updated_at'],properties:{
    schema_version:{const:1},id:uuid,workspace_id:uuid,reader_actor_id:uuid,source:ref('FeedSource'),title:{type:['string','null'],maxLength:256},status:{enum:['active','unsubscribed']},row_version:{type:'integer',minimum:1},created_at:{type:'string',format:'date-time'},updated_at:{type:'string',format:'date-time'}}},
  FeedItemState:{type:'object',required:['schema_version','id','workspace_id','reader_actor_id','subscription_id','item_id','read','dismissed','saved','row_version','updated_at'],properties:{
    schema_version:{const:1},id:uuid,workspace_id:uuid,reader_actor_id:uuid,subscription_id:uuid,item_id:{type:'string',minLength:1,description:'Opaque, at most 2048 UTF-8 bytes; never reused'},...flags,row_version:{type:'integer',minimum:1},updated_at:{type:'string',format:'date-time'}}},
  FeedSubscribeMutation:{type:'object',additionalProperties:false,required:['mutation_id','expected_row_version','source'],properties:{...mutation,expected_row_version:{const:0},source:ref('FeedSource'),title:{type:['string','null'],maxLength:256}}},
  FeedSubscriptionPatch:{type:'object',additionalProperties:false,required:['mutation_id','expected_row_version','patch'],properties:{...mutation,patch:{type:'object',additionalProperties:false,minProperties:1,properties:{status:{enum:['active','unsubscribed']},title:{type:['string','null'],maxLength:256},endpoint:{type:'string',description:'Immutable v1 /feed/<id> endpoint; cannot rekey'}}}}},
  FeedUnsubscribeMutation:{type:'object',additionalProperties:false,required:['mutation_id','expected_row_version'],properties:mutation},
  FeedStateMutation:{type:'object',additionalProperties:false,required:['mutation_id','expected_row_version','item_id','patch'],properties:{...mutation,item_id:{type:'string',minLength:1},patch:{type:'object',additionalProperties:false,minProperties:1,properties:flags}}},
  FeedReaderError:{type:'object',required:['error'],properties:{error:{type:'object',required:['code','message','retryable'],properties:{code:{type:'string'},message:{type:'string'},retryable:{type:'boolean'}}}}},
};
const base='/api/v4/flightdeck-pg/workspaces/{workspaceId}/feed-subscriptions';
function operation(summary:string,response:object,body?:string,list=false,item=false) {
  return {tags:['Flight Deck PG'],summary,description:'Verified NIP-98 signer + workspace membership. Personal reader scope; subscriptions never grant WApp access. No feed bodies. Mutation UUID retries return original acknowledgement; changed reuse and whole-row CAS conflict return 409. Unsubscribe retains identity/flags indefinitely. Recovery uses existing /records families feed_subscription/feed_item_state and reader-filtered /events/stream.',security:[{nip98:[]}],
    parameters:[{name:'workspaceId',in:'path',required:true,schema:uuid},...(item?[{name:'subscriptionId',in:'path',required:true,schema:uuid}]:[]),...(list?[
      {name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:200,default:50}},
      {name:'cursor',in:'query',schema:uuid,description:'Opaque server token scoped to reader, workspace and route; expires after 7 days. Lists are current keyset pages; use /records for consistent recovery.'}]:[])],
    ...(body?{requestBody:{required:true,content:{'application/json':{schema:ref(body)}}}}:{}),
    responses:{'200':{description:'Reader metadata',content:{'application/json':{schema:response}}},...Object.fromEntries([400,401,403,404,409].map(code=>[String(code),{description:({400:'Invalid request/cursor',401:'Existing NIP-98 authentication error',403:'Membership required',404:'Not found in reader scope',409:'state_conflict, subscription_inactive or mutation_id_reused'} as any)[code],content:{'application/json':{schema:code===401?ref('ErrorResponse'):ref('FeedReaderError')}}}]))}};
}
const subscription={type:'object',required:['subscription'],properties:{subscription:ref('FeedSubscription')}};
const state={type:'object',required:['item_state'],properties:{item_state:ref('FeedItemState')}};
const page=(key:string,type:string)=>({type:'object',required:[key,'next_cursor'],properties:{[key]:{type:'array',items:ref(type)},next_cursor:{type:['string','null'],format:'uuid'}}});
export const feedReaderPaths={
  [base]:{get:operation('List personal feed subscriptions including tombstones',page('subscriptions','FeedSubscription'),undefined,true),post:operation('Subscribe with source deduplication',subscription,'FeedSubscribeMutation')},
  [base+'/{subscriptionId}']:{get:operation('Get own subscription',subscription,undefined,false,true),patch:operation('Patch preference or explicitly resubscribe with CAS',subscription,'FeedSubscriptionPatch',false,true),delete:operation('Unsubscribe retaining identity and flags',subscription,'FeedUnsubscribeMutation',false,true)},
  [base+'/{subscriptionId}/item-states']:{get:operation('List personal flags including retained unsubscribed state',page('item_states','FeedItemState'),undefined,true,true),put:operation('Patch read/unread, dismissed and saved with CAS',state,'FeedStateMutation',false,true)},
};
