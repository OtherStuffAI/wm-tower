// Node's HTTP upgrade handling over a docker-exec stdio socket. Only the
// disposable client's explicit mesh IPv6 is dialed; no host-side TCP socket.
import {spawn} from 'node:child_process';
import {Duplex} from 'node:stream';
import {createInterface} from 'node:readline';
const {default: WS}=await import((process.env.AUTOPILOT_REPO ?? `${process.env.HOME}/code/wm/autopilot`)+'/node_modules/ws/index.js');
const [container,relay,address]=process.argv.slice(2);
let child;
const ws=new WS(relay,{handshakeTimeout:8000,followRedirects:false,createConnection:()=>{
  child=spawn('docker',['exec','-i',container,'node','-e',
    `const net=require('node:net');const s=net.connect({host:process.argv[1],port:Number(process.argv[2]),family:6});
     const t=setTimeout(()=>process.exit(2),8000);s.on('connect',()=>clearTimeout(t));
     s.on('error',()=>process.exit(2));s.on('close',()=>process.exit());
     process.stdin.pipe(s);s.pipe(process.stdout);process.stdin.on('end',()=>s.destroy());`,
    address,new URL(relay).port],{stdio:['pipe','pipe','ignore']});
  const socket=Duplex.from({readable:child.stdout,writable:child.stdin});
  child.on('exit',()=>socket.destroy());
  socket.setTimeout=()=>socket;socket.setNoDelay=()=>socket;socket.setKeepAlive=()=>socket;
  return socket;
}});
const out=m=>process.stdout.write(JSON.stringify(m)+'\n');
ws.on('message',d=>out(JSON.parse(String(d))));
ws.on('close',code=>{out(['SOCKET_CLOSED',code]);child?.kill();process.exit();});
ws.on('error',()=>{out(['SOCKET_ERROR']);child?.kill();process.exit(1);});
createInterface({input:process.stdin}).on('line',line=>{if(ws.readyState===WS.OPEN)ws.send(line);}).on('close',()=>{ws.terminate();child?.kill();});
process.on('SIGTERM',()=>{ws.terminate();child?.stdin?.end();child?.kill();process.exit();});
