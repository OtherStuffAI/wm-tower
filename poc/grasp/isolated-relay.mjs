// WebSocket over docker exec stdio, with no network or port on the restored service.
import {spawn} from 'node:child_process';
import {Duplex} from 'node:stream';
import {createInterface} from 'node:readline';
const {default: WS}=await import((process.env.AUTOPILOT_REPO ?? `${process.env.HOME}/code/wm/autopilot`)+'/node_modules/ws/index.js');
let child;
const ws=new WS(process.argv[3],{createConnection:()=>{
  child=spawn('docker',['exec','-i',process.argv[2],'bash','-c','exec 4<&0; exec 3<>/dev/tcp/127.0.0.1/7334; cat <&3 & incoming=$!; cat <&4 >&3 & outgoing=$!; wait -n; kill "$incoming" "$outgoing" 2>/dev/null'],{stdio:['pipe','pipe','ignore']});
  const socket=Duplex.from({readable:child.stdout,writable:child.stdin});
  child.on('exit',()=>socket.destroy());
  socket.setTimeout=()=>socket;socket.setNoDelay=()=>socket;socket.setKeepAlive=()=>socket;
  return socket;
}});
const out=m=>process.stdout.write(JSON.stringify(m)+'\n');
ws.on('message',d=>out(JSON.parse(String(d))));
ws.on('close',code=>{out(['SOCKET_CLOSED',code]);child?.kill();process.exit();});
ws.on('error',e=>{out(['SOCKET_ERROR',e.code ?? e.message]);child?.kill();process.exit(1);});
createInterface({input:process.stdin}).on('line',line=>{if(ws.readyState===WS.OPEN)ws.send(line);}).on('close',()=>{ws.terminate();child?.kill();});
process.on('SIGTERM',()=>{ws.terminate();child?.kill();process.exit();});
