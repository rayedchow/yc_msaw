// Host operational verification, not product implementation. Separate OS processes, real Modal object storage.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {TraceRecorder, FileTraceOutbox, InProcessTraceTransport, TraceTransportError} from '../src/sdk/client.ts';
import {TraceIngestor, readSessionBinding, listAll} from '../src/traces/ingest.ts';
import {conversationMembers} from '../src/traces/conversation.ts';
import {pinDailyManifest, markDailyStatus, materializeCohort} from '../src/traces/daily.ts';
import {buildTraceArchive} from '../src/traces/archive.ts';
import {ModalObjectStore} from '../src/store/modal-objects.ts';

const [mode, namespace, outdir] = process.argv.slice(2);
const payload = {kind:'synthetic-verification-payload', text:'restart-exact-payload-'.repeat(6000)};
const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const checks=[];
function check(name, yes, details) {assert(yes,name); checks.push({name,ok:true,...(details?{details}:{})});}
const store = new ModalObjectStore({timeoutMs:90000});
try {
  if (mode === 'write' || mode === 'resume') {
    const clock = mode === 'write' ? '2026-10-16T23:59:59Z' : '2026-10-17T00:00:01Z';
    const ingestor = new TraceIngestor(store, {now:()=>new Date(clock)});
    const actual = new InProcessTraceTransport(ingestor, namespace);
    const acks=[];
    const transport = {
      putBlob:(...args)=>actual.putBlob(...args),
      async sendChunk(chunk) {
        const ack=await actual.sendChunk(chunk); acks.push(ack);
        if (mode==='write') throw new TraceTransportError('Intentional loss of acknowledgement after actual Modal commit',null,true);
        return ack;
      }
    };
    const outbox = new FileTraceOutbox(outdir);
    const recorder = new TraceRecorder({transport,outbox,agent:{id:'host-verification',harness:'separate-process-smoke'},flushIntervalMs:0,maxRetries:0});
    if(mode==='write') {
      const trace = recorder.begin({sessionId:'ses-restart-root',conversationId:'customer-thread/verification',runId:'run-original',objective:'Synthetic operational verification, not customer training'});
      trace.startTurn('turn-original');
      trace.modelInput(payload,{spanId:'request.original'});
      await trace.checkpoint();
      await assert.rejects(trace.flush(), /Intentional loss of acknowledgement/);
      assert.equal(acks.length,1);
      const cp=JSON.parse(await outbox.readCheckpoint(trace.sessionId));
      assert.equal(cp.pending.length,1);
      assert.equal(cp.correlation.conversationId,'customer-thread/verification');
      console.log(JSON.stringify({pid:process.pid,mode,acks,checkpoint:{seq:cp.seq,chunkSeq:cp.chunkSeq,pending:cp.pending.length}}));
    } else {
      assert.deepEqual(await recorder.pendingSessions(),['ses-restart-root']);
      const trace=await recorder.resume('ses-restart-root');
      await trace.flush();
      assert.equal(acks[0].status,'duplicate');
      trace.startTurn('turn-after-restart');
      trace.note({afterRestart:true},{spanId:'request.continued'});
      const child=trace.child({sessionId:'ses-restart-child',objective:'Synthetic child verification',parentSpanId:'spawn.child'});
      child.startTurn('turn-child');
      child.note({child:true},{spanId:'child.work',parentSpanId:'spawn.child'});
      await child.finish({status:'succeeded',summary:'Synthetic child finished'});
      await trace.finish({status:'succeeded',summary:'Synthetic parent finished after process restart'});
      assert.deepEqual(await recorder.pendingSessions(),[]);
      const finished=await recorder.resume(trace.sessionId);
      assert.equal(finished.finished,true);
      await finished.flush();
      console.log(JSON.stringify({pid:process.pid,mode,acks,finished:true}));
    }
  } else {
    const ns='conv-smoke-'+Date.now().toString(36);
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'procmem-conv-smoke-'));
    await fs.chmod(dir,0o700);
    const runChild=(which)=>new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['--import','tsx',process.argv[1],which,ns,dir],{cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']});
      let out='',err=''; child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
      const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Verification child timeout'));},180000);
      child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error('Verification child failed: '+err.slice(-2500)));else{try{resolve(JSON.parse(out.trim().split('\n').at(-1)))}catch(e){reject(e)}}});
    });
    const first=await runChild('write');
    check('realModal.acceptedBeforeLostAck',first.acks[0].status==='created',first);
    const second=await runChild('resume');
    check('restart.separateOSProcess',first.pid!==second.pid,{firstPid:first.pid,secondPid:second.pid});
    check('restart.sameChunkDeduplicated',second.acks[0].status==='duplicate');
    const root=await readSessionBinding(store,ns,'ses-restart-root');
    const child=await readSessionBinding(store,ns,'ses-restart-child');
    check('conversation.stableAcrossRestart',root.correlation.conversationId==='customer-thread/verification'&&root.correlation.runId==='run-original');
    check('child.inheritsIdentityAndParent',child.correlation.conversationId===root.correlation.conversationId&&child.correlation.runId===root.correlation.runId&&child.correlation.parentSessionId===root.sessionId&&child.correlation.parentSpanId==='spawn.child');
    const members=await conversationMembers(store,ns,root.correlation.conversationId);
    check('conversation.membersIndexed',members.length===2,{members});
    check('tenant.isolated',(await conversationMembers(store,ns+'-other',root.correlation.conversationId)).length===0);
    const firstDay=await pinDailyManifest(store,ns,'2026-10-16');
    await markDailyStatus(store,ns,'2026-10-16',{manifestKey:firstDay.manifest.key,status:'published',revisionId:'verification-only'});
    const secondDay=await pinDailyManifest(store,ns,'2026-10-17');
    const coverage=secondDay.manifest.coverage.find(c=>c.sessionId==='ses-restart-root');
    check('daily.onlyNewChunks',secondDay.manifest.chunks.every(c=>!firstDay.manifest.chunks.some(old=>old.key===c.key)));
    check('daily.linksAlreadyProcessedHistory',coverage.prior.processedChunks===1&&!coverage.startsSession,{coverage});
    const inputs=await materializeCohort(store,ns,secondDay.manifest);
    check('builder.inputsMaterialized',inputs.size>0,{files:inputs.size});
    const archive=await buildTraceArchive(store,ns);
    check('builder.archiveContainsBothDays',archive.dayList.includes('2026-10-16')&&archive.dayList.includes('2026-10-17'),archive.summary());
    check('builder.fullPayloadPreserved',[...archive.files.values()].some(text=>text.includes(payload.text)),{payloadBytes:Buffer.byteLength(JSON.stringify(payload)),payloadSha256:payloadHash});
    const keys=await listAll(store,ns,'traces/'); const objects=await store.get(ns,keys); const events=[];
    for(const key of keys) for(const line of gunzipSync(objects.get(key)).toString().trim().split('\n'))events.push(JSON.parse(line));
    const rootEvents=events.filter(e=>e.sessionId==='ses-restart-root').sort((a,b)=>a.seq-b.seq);
    check('events.noLossOrDuplicate',rootEvents.every((e,i)=>e.seq===i+1)&&rootEvents.filter(e=>e.type==='session_end').length===1,{seqs:rootEvents.map(e=>e.seq),turnIds:[...new Set(rootEvents.map(e=>e.turnId).filter(Boolean))]});
    const report={kind:'sdk-conversation-modal-smoke',at:new Date().toISOString(),scope:'Separate OS processes and actual Modal object storage; synthetic receipt clocks cross midnight; no vendor/model calls',verificationScript:'scripts/sdk-conversation-modal-smoke.mjs',namespace:ns,checks};
    await fs.writeFile('reports/sdk-conversation-modal-smoke.json',JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({passed:checks.length,allPassed:true,report:'reports/sdk-conversation-modal-smoke.json'}));
  }
} finally {store.close();}
