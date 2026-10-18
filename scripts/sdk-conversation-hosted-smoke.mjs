// Host operational check. Requires the protected .context/hosted-demo-client.json configured for the demo tenant.
// Run: node --import tsx scripts/sdk-conversation-hosted-smoke.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {TraceRecorder,FileTraceOutbox,HttpTraceTransport,TraceTransportError,newSessionId} from '../src/sdk/client.ts';
import {ModalObjectStore} from '../src/store/modal-objects.ts';
import {readSessionBinding} from '../src/traces/ingest.ts';
import {conversationMembers} from '../src/traces/conversation.ts';
const d=JSON.parse(await fs.readFile('.context/hosted-demo-client.json','utf8'));
const checks=[];const acks=[];const sent=[];let credentialsRequested=0;
function check(name,ok,detail){assert(ok,name);checks.push({name,ok:true,...(detail?{detail}:{})});}
const real=new HttpTraceTransport({baseUrl:d.baseUrl,token:async()=>{credentialsRequested++;return d.keys.trace}});
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'procmem-hosted-resume-'));await fs.chmod(dir,0o700);
const outbox=new FileTraceOutbox(dir);
const opts={agent:{id:'host-wire-verification',harness:'synthetic-operational-smoke'},outbox,flushIntervalMs:0,maxRetries:0};
const broken={putBlob:(...args)=>real.putBlob(...args),async sendChunk(chunk){sent.push(chunk);const ack=await real.sendChunk(chunk);acks.push(ack);throw new TraceTransportError('Intentional lost HTTP acknowledgement after accepted server write',null,true)}};
const r1=new TraceRecorder({...opts,transport:broken});
const conversationId='verification/hosted-'+Date.now().toString(36);
const trace=r1.begin({objective:'Synthetic hosted wire verification; not a customer task',conversationId,runId:'run-hosted'});
trace.startTurn('turn-http');trace.note({kind:'host-wire-verification'},{spanId:'request.first'});
await assert.rejects(trace.flush(),/Intentional lost HTTP acknowledgement/);
check('http.newCorrelatedChunkAccepted',acks[0]?.status==='created',{sessionId:trace.sessionId,day:acks[0].day});
const reliable={putBlob:(...args)=>real.putBlob(...args),async sendChunk(chunk){const ack=await real.sendChunk(chunk);acks.push(ack);return ack}};
const r2=new TraceRecorder({...opts,transport:reliable});
const resumed=await r2.resume(trace.sessionId);await resumed.flush();
check('http.lostAckResendDeduplicated',acks[1]?.status==='duplicate');
await assert.rejects(real.sendChunk({...sent[0],correlation:{...sent[0].correlation,conversationId:conversationId+'-retarget'}}),e=>e instanceof TraceTransportError&&e.status===409&&e.code==='correlation_mismatch');
check('http.identicalEventRetryCannotRetargetConversation',true);
const child=resumed.child({objective:'Synthetic hosted child verification',parentSpanId:'spawn.http'});
child.note({kind:'host-child-verification'});await child.finish({status:'succeeded',summary:'Synthetic verification'});
await resumed.finish({status:'succeeded',summary:'Synthetic hosted restart verification'});
check('outbox.fullyDeliveredTombstone',(await r2.pendingSessions()).length===0);
const store=new ModalObjectStore();
try{
 const parentBinding=await readSessionBinding(store,d.tenantNs,resumed.sessionId);
 const childBinding=await readSessionBinding(store,d.tenantNs,child.sessionId);
 check('modal.authenticatedTenantContainsCorrelation',parentBinding?.correlation?.conversationId===conversationId&&parentBinding?.correlation?.runId==='run-hosted');
 check('modal.childParentLinksPersisted',childBinding?.correlation?.parentSessionId===resumed.sessionId&&childBinding?.correlation?.parentSpanId==='spawn.http');
 check('modal.conversationMemberCount',(await conversationMembers(store,d.tenantNs,conversationId)).length===2);
 check('modal.otherTenantHasNoMembership',(await conversationMembers(store,d.tenantNs+'-other',conversationId)).length===0);
 const sid=newSessionId();const legacy={sessionId:sid,chunkSeq:1,events:[{sessionId:sid,seq:1,ts:new Date().toISOString(),type:'note',agent:{id:'host-legacy-wire-verification'},data:null}]};
 check('http.oldSdkChunkStillAccepted',(await real.sendChunk(legacy)).status==='created');
 check('http.oldSdkRetryStillIdempotent',(await real.sendChunk(legacy)).status==='duplicate');
 await assert.rejects(real.sendChunk({...legacy,correlation:{conversationId,runId:'run-new',conversationSource:'explicit'}}),e=>e instanceof TraceTransportError&&e.status===409);
 check('http.legacyRetryCannotAddCorrelation',true);
 check('modal.legacySessionRemainsUncorrelated',(await readSessionBinding(store,d.tenantNs,sid))?.correlation===null);
}finally{store.close()}
check('credentials.providerCalledPerRequest',credentialsRequested>=8,{requests:credentialsRequested});
const report={kind:'sdk-conversation-hosted-wire-smoke',at:new Date().toISOString(),baseUrl:d.baseUrl,sourceCommit:'a039d505441b06bbab2af98e98dc9335e88c6ae9',verificationScript:'scripts/sdk-conversation-hosted-smoke.mjs',conversationId,checks};
await fs.writeFile('reports/sdk-conversation-hosted-wire-smoke.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({checks:checks.length,allPassed:true}));
