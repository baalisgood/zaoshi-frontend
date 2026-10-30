import { runConsumerDaemon, type ConsumerDaemonOptions } from './daemon';
import type { ConsumerHealthReporter, ConsumerHealthSnapshot } from './health';

type Slot = Omit<ConsumerDaemonOptions, 'health' | 'signal'>;
export async function runConsumerPool(slots: Slot[], health: ConsumerHealthReporter, signal: AbortSignal): Promise<void> {
 if(slots.length<1||slots.length>3)throw new Error('INVALID_CONSUMER_POOL_SIZE');
 const controller=new AbortController(), snapshots=new Map<number,ConsumerHealthSnapshot>();
 let writes=Promise.resolve(), fatal=false;
 const stop=()=>controller.abort();
 signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
 async function publish(index:number,snapshot:ConsumerHealthSnapshot) {
  snapshots.set(index,structuredClone(snapshot));
  const values=[...snapshots.values()],combined=structuredClone(snapshot);
  combined.startedAt=values.map(s=>s.startedAt).sort()[0];
  combined.lastSuccessAt=values.every(s=>s.lastSuccessAt)?values.map(s=>s.lastSuccessAt!).sort()[0]:null;
  combined.state=fatal||values.some(s=>s.state==='degraded'||Date.now()-Date.parse(s.updatedAt)>120000)?'degraded'
    :values.length<slots.length?'starting':values.every(s=>s.state==='stopped')?'stopped'
    :values.some(s=>s.state==='draining'||s.state==='stopped')?'draining':values.every(s=>s.state==='ready')?'ready':'starting';
  combined.lastErrorCode=fatal?'CONSUMER_SLOT_FAILED':values.find(s=>s.lastErrorCode)?.lastErrorCode??null;
  for(const key of Object.keys(combined.counters) as Array<keyof ConsumerHealthSnapshot['counters']>)combined.counters[key]=values.reduce((n,s)=>n+s.counters[key],0);
  writes=writes.catch(()=>undefined).then(()=>health.write(combined));await writes;
 }
 try {
  const results=await Promise.allSettled(slots.map((slot,index)=>runConsumerDaemon({...slot,signal:controller.signal,health:{write:s=>publish(index,s)}}).catch(async error=>{
   fatal=true;stop();const snapshot=snapshots.get(index);if(snapshot)await publish(index,snapshot);throw error;
  })));
  await writes;
  const failed=results.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
 } finally {signal.removeEventListener('abort',stop);}
}
