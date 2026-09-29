import {test,expect} from 'bun:test';
test('native mode rejects malicious hints and Git destinations without dialing the trap',async()=>{
  let connections=0;
  const trap=Bun.listen({hostname:'127.0.0.1',port:0,socket:{open(socket){connections++;socket.end();},data(){}}});
  try {
    const env={...process.env};
    for(const key of Object.keys(env)) if(/^(GIT_|NGIT_|WINGMAN_CAPABILITY|SESSION_ID)/.test(key)) delete env[key];
    Object.assign(env,{NGIT_POC_PRIVATE_SERVICE:'1',NGIT_TOR_PROXY:'off',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'});
    const proc=Bun.spawn([`${process.env.HOME}/code/ngit-poc/ngit/target/debug/examples/poc_destination_probe`,
      `ws://127.0.0.1:${trap.port}/`, `http://127.0.0.1:${trap.port}/synthetic.git`],{env,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
    const timer=setTimeout(()=>proc.kill(),10000);
    const code=await proc.exited;clearTimeout(timer);
    // Output omitted; broker capability/session credentials were removed above.
    expect(code).toBe(0);
    expect(connections).toBe(0);
  } finally {trap.stop(true);}
},15000);
