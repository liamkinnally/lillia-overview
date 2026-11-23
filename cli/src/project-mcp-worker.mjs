// The attested launcher prefixes the shared protocol and starts this fixed program inside Seatbelt.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
const [taskId,attemptId,role,socketPath,credentialFile,fileIdentity]=process.argv.slice(1);
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
const need=(ok)=>{if(!ok)throw Error('Project transport refused.');};
need(Object.keys(process.env).length===0);
const seen=new Set();
async function broker(tool,input){
  protocol.args(role,tool,input);
  const fd=fs.openSync(credentialFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  let credential;
  try{
    const s=fs.fstatSync(fd,{bigint:true});
    need(s.isFile()&&s.nlink===1n&&s.uid===BigInt(process.getuid())&&(s.mode&0o777n)===0o600n&&s.size===44n&&String(s.dev)+':'+String(s.ino)===fileIdentity);
    const b=Buffer.alloc(45);need(fs.readSync(fd,b,0,b.length,0)===44&&b[43]===10);
    credential=b.subarray(0,43).toString('utf8');need(/^[A-Za-z0-9_-]{43}$/.test(credential));
  }finally{fs.closeSync(fd);}
  const operationId=crypto.randomUUID(),request=JSON.stringify({version:1,taskId,attemptId,credential,operationId,tool,arguments:input});
  const result=await new Promise((resolve,reject)=>{
    const req=http.request({socketPath,method:'POST',path:'/v1/project-mcp',agent:false,headers:{'content-type':'application/json','content-length':Buffer.byteLength(request)}},res=>{
      const chunks=[];let size=0;
      res.on('data',c=>{size+=c.length;if(size>96000)return req.destroy(Error('Oversized project response'));chunks.push(c);});
      res.once('aborted',()=>reject(Error('Incomplete project response')));res.once('error',reject);
      res.once('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString('utf8')}));
    });
    const timer=setTimeout(()=>req.destroy(Error('Project operation timed out')),tool==='run_check'?95000:25000);
    req.once('close',()=>clearTimeout(timer));req.once('error',reject);req.end(request);
  });
  need([200,403,409].includes(result.status)&&!result.body.includes(credential));
  const p=JSON.parse(result.body);
  need(p?.version===1&&p.operationId===operationId&&typeof p.observationId==='string'&&typeof p.text==='string'&&p.digest===digest(p.text));
  return {isError:result.status!==200,content:[{type:'text',text:JSON.stringify({version:1,operationId,observationId:p.observationId,digest:p.digest,text:p.text})}]};
}
async function handle(line){
  const q=JSON.parse(line);need(q.jsonrpc==='2.0'&&typeof q.method==='string');
  if(!Object.hasOwn(q,'id'))return;
  need(typeof q.id==='string'&&q.id.length<=128||Number.isSafeInteger(q.id));
  let result,error;
  if(q.method==='initialize')result={protocolVersion:['2025-11-25','2025-06-18','2025-03-26','2024-11-05'].includes(q.params?.protocolVersion)?q.params.protocolVersion:'2025-06-18',
    capabilities:{tools:{}},serverInfo:{name:'lillia-project',version:'1'}};
  else if(q.method==='tools/list')result={tools:protocol.tools(role).map(protocol.descriptor)};
  else if(q.method==='ping')result={};
  else if(q.method==='tools/call'){
    need(!seen.has(q.id)&&seen.size<32);seen.add(q.id);
    result=await broker(q.params.name,q.params.arguments);
  }else error={code:-32601,message:'Unknown method'};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,...(error?{error}:{result})})+'\n');
}
(async()=>{
  let pending='';process.stdin.setEncoding('utf8');
  for await(const chunk of process.stdin){pending+=chunk;
    for(let index;(index=pending.indexOf('\n'))>=0;){const line=pending.slice(0,index);pending=pending.slice(index+1);need(Buffer.byteLength(line)<=96000);if(line.trim())await handle(line);}
    need(Buffer.byteLength(pending)<=96000);
  }
  need(!pending.trim());
})().catch(()=>{process.exitCode=1;process.stdin.destroy();});
