import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,statfs} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {dependencySet,extractProgram,requireCheck,sum,cacheDirectory,hostToolchain} from './project-validation-tools.mjs';
import {runnerConfig,seatbelt,testPath} from './project-validation-profile.mjs';

const python='/usr/bin/python3';
const launch=String.raw`import os,resource,sys
for which,soft,hard in [(resource.RLIMIT_CORE,0,0),(resource.RLIMIT_CPU,24,26),(resource.RLIMIT_FSIZE,0,0),(resource.RLIMIT_NOFILE,256,256)]:
 resource.setrlimit(which,(soft,hard))
os.execve('/usr/bin/sandbox-exec',sys.argv[1:],os.environ)
`;
function execute(args,{cwd,env={},input='',timeout,maxOutput}){
  return new Promise((resolve,reject)=>{
    const child=spawn(python,['-I','-S',...args],{cwd,env,stdio:['pipe','pipe','pipe'],detached:true});
    let bytes=0,stopped=false;const out=[],err=[];
    function kill(){try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}
    const timer=setTimeout(()=>{stopped=true;kill();},timeout);
    for(const [stream,chunks] of [[child.stdout,out],[child.stderr,err]])stream.on('data',chunk=>{
      bytes+=chunk.length;if(bytes>maxOutput){stopped=true;kill();}else chunks.push(chunk);
    });
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('close',code=>{clearTimeout(timer);kill();resolve({code,stopped,stdout:Buffer.concat(out),stderr:Buffer.concat(err)});});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
export function parseCheck(result,filename){
  const unavailable=detail=>({outcome:'unavailable',checks:[],detail,observation:null,reportDigest:null});
  if(result.stopped)return unavailable('The fixed test exceeded its time or output allowance.');
  let report;try{report=JSON.parse(result.stdout);}catch{return unavailable('The fixed test did not return a complete Vitest report.');}
  const suite=report.testResults?.[0],assertions=suite?.assertionResults;
  if(report.testResults?.length!==1||suite.name!==filename||!Array.isArray(assertions)||!assertions.length||assertions.length>32||
    report.numTotalTests!==assertions.length||report.numTotalTestSuites!==1||report.numPendingTests!==0||report.numTodoTests!==0)
    return unavailable('The report must contain one complete supported suite with no skipped or pending tests.');
  const checks=[];
  for(const a of assertions){
    if(typeof a.fullName!=='string'||!a.fullName.trim()||a.fullName.length>300||!['passed','failed'].includes(a.status)||!Array.isArray(a.failureMessages))
      return unavailable('Vitest returned an incomplete test case.');
    const message=a.failureMessages[0];
    const firstLine=typeof message==='string'?message.split('\n',1)[0]:'';
    const recognized=/^(?:AssertionError(?: \[ERR_ASSERTION\])?:|TestingLibraryElementError: (?:Unable to find|Found multiple)|Error: expect\([^()\n]{0,120}\)\.(?:not\.)?to[A-Z][A-Za-z]+\()/.test(firstLine);
    if(a.status==='failed'&&!recognized)
      return unavailable('A test stopped without a recognized assertion or Testing Library lookup failure.');
    checks.push({title:a.fullName,status:a.status,assertionFailure:a.status==='failed',detail:a.status==='failed'?message.split(/\n\s+at |\nIgnored nodes:/)[0].slice(0,500):null});
  }
  const failed=checks.filter(t=>t.assertionFailure).length;
  if(new Set(checks.map(c=>c.title)).size!==checks.length||report.numFailedTests!==failed||report.numPassedTests!==checks.length-failed||
    report.success!==(failed===0)||result.code!==(failed?1:0)||suite.status!==(failed?'failed':'passed'))
    return unavailable('Vitest process and suite outcomes disagree.');
  const outcome=failed?'failed':'passed';
  const observation={exitCode:result.code,stdoutDigest:sum(result.stdout),testPath,suites:1,cases:checks.length,passed:checks.length-failed,failed};
  return {outcome,checks,detail:null,observation,reportDigest:sum(JSON.stringify([observation,checks,outcome]))};
}
export async function runProjectCheck({dataDir,files}){
  await hostToolchain();
  const stats=await statfs('/private/tmp',{bigint:true});requireCheck(stats.bavail*stats.bsize>=3n*1024n**3n,'Insufficient headroom for isolated component testing.');
  const dir=await mkdtemp('/private/tmp/lillia-component-'),root=join(dir,'frontend'),scratch=join(dir,'scratch');
  try{
    await mkdir(root);await mkdir(scratch);
    for(const {path,bytes} of files){
      const file=join(dir,path);await mkdir(dirname(file),{recursive:true});await writeFile(file,bytes,{flag:'wx',mode:0o400});
    }
    await writeFile(join(root,'isolated.config.mts'),runnerConfig,{flag:'wx',mode:0o400});
    const deps=dependencySet(files.find(f=>f.path==='frontend/package-lock.json').bytes);
    const prepared=await execute(['-c',extractProgram,cacheDirectory(dataDir)],{cwd:root,input:JSON.stringify(deps),timeout:45000,maxOutput:8192});
    requireCheck(prepared.code===0&&!prepared.stopped,'Pinned dependencies could not be verified and unpacked. Re-enroll the local toolchain cache.');
    const exe=process.execPath,esbuild=join(root,'node_modules/@esbuild/darwin-arm64/bin/esbuild');
    const params={base:dir,node:exe,inputs:root,scratch,esbuild,rollup:join(root,'node_modules/@rollup/rollup-darwin-arm64/rollup.darwin-arm64.node')};
    const args=['/usr/bin/sandbox-exec',...Object.entries(params).flatMap(([k,v])=>['-D',k+'='+v]),'-p',seatbelt,exe,
      '--openssl-config=/dev/null','--no-global-search-paths','--max-old-space-size=384',join(root,'node_modules/vitest/vitest.mjs'),
      'run','--config','isolated.config.mts',testPath.slice(9),'--configLoader','native','--no-cache','--pool=threads','--maxWorkers=1','--no-file-parallelism','--reporter=json'];
    const env={HOME:scratch,TMPDIR:scratch,ESBUILD_BINARY_PATH:esbuild,CI:'1',NO_COLOR:'1',TZ:'UTC',GOMAXPROCS:'2',UV_THREADPOOL_SIZE:'2',DEBUG_PRINT_LIMIT:'800'};
    return parseCheck(await execute(['-c',launch,...args],{cwd:root,env,timeout:35000,maxOutput:65536}),join(dir,testPath));
  }finally{await rm(dir,{recursive:true,force:true});}
}
