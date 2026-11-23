import {createHash,randomUUID} from 'node:crypto';
import {constants,createReadStream,readFileSync} from 'node:fs';
import {open,readFile,mkdir,rename,rm,realpath} from 'node:fs/promises';
import {homedir,release} from 'node:os';
import {join} from 'node:path';
import {privateRoot} from './installation-gate.mjs';
import {packages,nodeDigest,profile,runnerConfig,seatbelt,baseFiles} from './project-validation-profile.mjs';

export const sum=(bytes,algorithm='sha256')=>createHash(algorithm).update(bytes).digest('hex');
export function requireCheck(value,message,status=409){if(!value)throw Object.assign(new Error(message),{status});}
const sourceDigest=name=>sum(readFileSync(new URL(name,import.meta.url)));
export const toolchainDigest=sum(JSON.stringify({profile,nodeDigest,lock:baseFiles['frontend/package-lock.json'],packages,runnerConfig,seatbelt,
  runner:sourceDigest('./project-validation-runner.mjs'),installer:sourceDigest('./project-validation-tools.mjs')}));
const loaderDigest='06215a5d32689aefe395c29710e182eb54ba22162f50df8b4842290f8a19bf1c';
async function readRegular(file,max){
  const fd=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const s=await fd.stat();requireCheck(s.isFile()&&s.size>0&&s.size<=max,'A pinned tooling input is unavailable or exceeds its bound.');
    const data=Buffer.alloc(s.size);
    let n=0;while(n<data.length){const r=await fd.read(data,n,data.length-n,n);requireCheck(r.bytesRead>0,'Truncated pinned tooling input.');n+=r.bytesRead;}
    requireCheck((await fd.stat()).size===s.size,'Pinned tooling input changed.');return data;
  }finally{await fd.close();}
}
export async function hostToolchain(){
  requireCheck(process.platform==='darwin'&&process.arch==='arm64'&&release()==='25.3.0'&&process.version==='v24.22.2',
    'This fixed browser component check needs its enrolled macOS arm64 Node 24.22.2 host.');
  const digest=createHash('sha256');for await(const b of createReadStream(process.execPath))digest.update(b);
  requireCheck(digest.digest('hex')===nodeDigest&&sum(await readFile('/System/Library/Sandbox/Profiles/dyld-support.sb'))===loaderDigest,'Pinned Node runtime or Seatbelt loader differs.');
}
export function dependencySet(lockBytes){
  requireCheck(sum(lockBytes)===baseFiles['frontend/package-lock.json'],'The component check requires the enrolled package-lock bytes.');
  const lock=JSON.parse(lockBytes).packages;
  return packages.map(path=>{
    const s=lock[path]?.integrity;
    requireCheck(typeof s==='string'&&/^sha512-[A-Za-z0-9+/]{86}==$/.test(s),'Unexpected dependency integrity format.');
    return {path,sha512:Buffer.from(s.slice(7),'base64').toString('hex')};
  });
}
export function cacheDirectory(dataDir){return join(privateRoot(dataDir),'project-validation-cache');}
export async function prepareTools(dataDir,lockBytes){
  await hostToolchain();
  const cache=cacheDirectory(dataDir);await mkdir(cache,{recursive:true,mode:0o700});privateRoot(cache);
  const npm=join(homedir(),'.npm','_cacache','content-v2','sha512');
  for(const {sha512} of dependencySet(lockBytes)){
    const dest=join(cache,sha512);
    try{if(sum(await readRegular(dest,64*1024**2),'sha512')===sha512)continue;}catch(e){if(e.code!=='ENOENT')throw e;}
    const src=join(npm,sha512.slice(0,2),sha512.slice(2,4),sha512.slice(4));
    requireCheck(await realpath(src)===src,'Dependency cache input must be a canonical regular file.');
    const bytes=await readRegular(src,64*1024**2);requireCheck(sum(bytes,'sha512')===sha512,'Dependency archive differs from the approved lock.');
    const tmp=join(cache,'.stage-'+randomUUID());
    try{
      const fd=await open(tmp,'wx',0o600);try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
      await rename(tmp,dest);
    }finally{await rm(tmp,{force:true});}
  }
  const fd=await open(cache,'r');try{await fd.sync();}finally{await fd.close();}
}

// The trusted installer runs with Python isolated mode. It rehashes each archive just before
// unpacking regular files into a fresh private directory. No lifecycle hooks or package code run.
export const extractProgram=String.raw`import base64,hashlib,io,json,os,pathlib,shutil,stat,sys,tarfile
root=pathlib.Path.cwd()
cache=pathlib.Path(sys.argv[1])
total=0
entries=0
for item in json.load(sys.stdin):
 name=item['path']
 digest=item['sha512']
 assert len(digest)==128 and all(x in '0123456789abcdef' for x in digest)
 assert name.startswith('node_modules/') and '..' not in pathlib.PurePosixPath(name).parts
 fd=os.open(cache/digest,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,'rb') as f:
  info=os.fstat(f.fileno())
  assert stat.S_ISREG(info.st_mode) and 0<info.st_size<=64*1024**2
  blob=f.read(info.st_size+1)
  assert len(blob)==info.st_size and hashlib.sha512(blob).hexdigest()==digest
 with tarfile.open(fileobj=io.BytesIO(blob),mode='r:gz') as tar:
  for item in tar:
   relative=pathlib.PurePosixPath(item.name)
   parts=relative.parts
   assert parts and not relative.is_absolute() and '..' not in parts and len(parts)<=48
   if item.isdir() or len(parts)==1:continue
   entries+=1
   total+=item.size
   assert item.isfile() and entries<=50000 and item.size<=64*1024**2 and total<=700*1024**2
   path=root/name/pathlib.Path(*parts[1:])
   path.parent.mkdir(exist_ok=True,parents=True)
   if path.exists():
    assert path.read_bytes()==tar.extractfile(item).read()
    continue
   with path.open('xb') as out:shutil.copyfileobj(tar.extractfile(item),out)
   if name=='node_modules/@esbuild/darwin-arm64' and parts[1:]==('bin','esbuild'):path.chmod(0o500)
`;
