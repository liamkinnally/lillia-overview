import {jsLive,jsHistoric} from './native-javascript.mjs';
import {createHash} from 'node:crypto';
import {readFileSync,openSync,readSync,fstatSync,closeSync} from 'node:fs';
import {NativeStore,nativeFileId,validateNativeId} from './native-store.mjs';
import {makeReviewRecipe,evaluateFileRecipe} from './git-review-recipe.mjs';

const sha=v=>createHash('sha256').update(v).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const digest=v=>sha(JSON.stringify(v));
function need(ok,message,status=409){if(!ok)throw Object.assign(new Error(message),{status});}
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(s);
export const nativeReleaseTables=['native_prerequisites','native_release_artifacts','native_release_candidates'];
export function installNativeRelease(db){
  db.exec(`CREATE TABLE IF NOT EXISTS native_prerequisites(revisionId TEXT NOT NULL REFERENCES native_submissions(id),
    position INTEGER NOT NULL,prerequisite TEXT NOT NULL REFERENCES native_submissions(id),PRIMARY KEY(revisionId,position),UNIQUE(revisionId,prerequisite));
    CREATE TABLE IF NOT EXISTS native_release_artifacts(digest TEXT PRIMARY KEY,bytes BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS native_release_candidates(id TEXT PRIMARY KEY,operationId TEXT UNIQUE NOT NULL,revisionId TEXT NOT NULL REFERENCES native_submissions(id),
      artifactDigest TEXT NOT NULL REFERENCES native_release_artifacts(digest),record TEXT NOT NULL);`);
}
export function nativePrerequisiteIds(values=[]){
  need(Array.isArray(values)&&values.length<=8&&values.every(uuid)&&new Set(values).size===values.length,
    'Select up to eight distinct immutable native prerequisite submission IDs',400);
  return [...values];
}
function submission(db,id){
  const row=db.prepare('SELECT record FROM native_submissions WHERE id=?').get(id);need(row,'Unknown native prerequisite or release submission');
  const r=JSON.parse(row.record);need(r.id===id,'Native submission identity changed');return r;
}
function stored(db,r){
  const edges=db.prepare('SELECT position,prerequisite FROM native_prerequisites WHERE revisionId=? ORDER BY position').all(r.id);
  need(edges.every((e,i)=>e.position===i)&&same(edges.map(e=>e.prerequisite),r.requires??[]),'Native prerequisite edges do not match the immutable subject');
}
export function persistNativePrerequisites(db,r){
  if(!r.requires?.length)return;
  const insert=db.prepare('INSERT INTO native_prerequisites VALUES(?,?,?)');r.requires.forEach((id,i)=>insert.run(r.id,i,id));
}
export function nativePrerequisites(db,r,{target,generation,historical=false}={}){
  const ids=nativePrerequisiteIds(r.requires),ordered=new Map(),versions=new Map();
  let traversed=0;
  function walk(current,ancestors,paths){
    for(const id of nativePrerequisiteIds(current.requires)){
      need(++traversed<=128&&ancestors.size<=16,'Native prerequisite graph exceeds its closure limit');
      const dep=submission(db,id);stored(db,dep);
      need(dep.repository===r.repository&&dep.epoch===r.epoch&&dep.policyDigest===r.policyDigest,'Native prerequisite is outside the selected repository epoch or policy');
      need(!ancestors.has(dep.goalId)&&!paths.has(dep.path),'Native prerequisite logical goal cycle or overlapping path');
      need(!versions.has(dep.goalId)||versions.get(dep.goalId)===id,'Multiple versions of a prerequisite goal are ambiguous');
      versions.set(dep.goalId,id);
      if(!historical){
        const latest=db.prepare("SELECT id FROM native_submissions WHERE json_extract(record,'$.goalId')=? ORDER BY rowid DESC LIMIT 1").get(dep.goalId);
        need(latest?.id===id,'Native prerequisite was superseded. A fresh dependent revision is required.');
      }
      walk(dep,new Set([...ancestors,dep.goalId]),new Set([...paths,dep.path]));ordered.set(id,dep);
    }
  }
  if(!ids.length)return [];
  walk(r,new Set([r.goalId]),new Set([r.path]));
  if(!target)return [...ordered.keys()];
  const tree=new NativeStore({db}).tree({repository:r.repository,revisionId:target});
  const entries=new Map(tree.entries.map(e=>[e.path,e]));
  return [...ordered.values()].map(dep=>{
    const row=db.prepare('SELECT record FROM native_landings WHERE revisionId=?').get(dep.id),l=row&&JSON.parse(row.record);
    if(!l||l.generation>generation)throw Object.assign(new Error('Required native prerequisite must land before the dependent check'),{status:409,code:'NATIVE_PREREQUISITE_WAIT'});
    const e=db.prepare('SELECT * FROM native_ref_events WHERE operationId=?').get(l.operationId),file=entries.get(dep.path);
    need(e&&e.repository===r.repository&&e.name==='mainline'&&e.generation===l.generation&&e.revisionId===l.candidate&&
      file?.mode==='100644'&&file.fileId===dep.newFileId,'Landed native prerequisite bytes, mode or target changed');
    return {revisionId:dep.id,commit:dep.commit,goalId:dep.goalId,path:dep.path,fileId:dep.newFileId,landing:l.operationId,
      target:l.candidate,generation:l.generation,reviewId:l.reviewId,checkId:l.checkId};
  });
}

const recipeVersion='native-granted-files-json-v1';
const builderCode={builder:recipeVersion,node:process.version,implementation:sha(readFileSync(new URL(import.meta.url))),
  assertionEvaluator:sha(readFileSync(new URL('./git-review-recipe.mjs',import.meta.url)))};
let cachedToolchain;
function currentToolchain(){
  if(cachedToolchain)return cachedToolchain;
  const fd=openSync(process.execPath,'r');
  try{
    const before=fstatSync(fd,{bigint:true});
    need(before.isFile()&&before.size>0n&&before.size<=256n*1024n*1024n,'Unsupported native builder runtime image');
    const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let total=0;
    while(total<Number(before.size)){
      const count=readSync(fd,buffer,0,Math.min(buffer.length,Number(before.size)-total),total);
      need(count>0,'Runtime image changed while fingerprinting');hash.update(buffer.subarray(0,count));total+=count;
    }
    const after=fstatSync(fd,{bigint:true});
    need(before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.ctimeNs===after.ctimeNs,'Runtime image changed while fingerprinting');
    cachedToolchain=Object.freeze({...builderCode,runtimeImageSha256:hash.digest('hex')});return cachedToolchain;
  }finally{closeSync(fd);}
}
export function normalizeRelease(input){
  need(input&&['revisionId','expectedTarget','expectedGeneration'].every(k=>Object.hasOwn(input,k))&&
    Object.keys(input).every(k=>['revisionId','expectedTarget','expectedGeneration','checks'].includes(k))&&uuid(input.revisionId)&&
    Number.isSafeInteger(input.expectedGeneration)&&input.expectedGeneration>=2,'Select the landed submission and exact mainline generation',400);
  const {revisionId,expectedTarget,expectedGeneration}=input;validateNativeId(expectedTarget);
  return {revisionId,expectedTarget,expectedGeneration,checks:makeReviewRecipe('release',expectedTarget,input.checks??[]).checks};
}
function build(db,r,input,execution){
  const {repository}=r,revisionId=input.expectedTarget;
  const snap=new NativeStore({db}).select({repository,revisionId}),paths=[...new Set([...r.policy.allowedPaths,...(r.ownerPolicy?[r.path]:[])])].filter(path=>!path.endsWith('.cjs')||path===r.path&&r.jsRecipe).sort();
  const files=paths.map(path=>{
    const f=snap.read(path);need(f.mode==='100644'&&f.bytes.length<=4096,'Native release input exceeds the regular 4 KiB profile');
    return {path,mode:f.mode,fileId:f.fileId,base64:f.bytes.toString('base64')};
  });
  if(r.jsRecipe)need(execution?.evidence.state==='passed'&&snap.read(r.path).fileId===execution.evidence.sourceFileId,'JavaScript artifact requires passing execution on exact published bytes');
  const builtJs=execution?{...execution.evidence,cachedData:execution.run.cachedData}:null;
  const artifact=Buffer.from(JSON.stringify({format:recipeVersion,repository,revisionId,files,...(builtJs?{javascript:builtJs}:{})}));
  const parsed=JSON.parse(artifact),contents=new Map();
  for(const e of parsed.files){
    const bytes=Buffer.from(e.base64,'base64');
    need(nativeFileId(bytes)===e.fileId&&bytes.toString('base64')===e.base64,'Built native artifact differs from selected file');
    contents.set(e.path,{mode:e.mode,bytes});
  }
  const recipe={builder:recipeVersion,paths,policyDigest:r.policyDigest,projectChecks:r.policy.checks,releaseChecks:input.checks,...(execution?{javascript:execution.evidence}:{})};
  const failures=evaluateFileRecipe(path=>contents.get(path),[...recipe.projectChecks,...recipe.releaseChecks]);
  return {artifact,artifactDigest:sha(artifact),recipe,recipeDigest:digest(recipe),validation:{profile:'native-artifact-json-assertions-v1',
    verifiedFiles:files.map(({path,mode,fileId})=>({path,mode,fileId})),failures},state:failures.length?'failed':'passed'};
}
export function probeReleaseArtifact(db,release,source){
  const r=submission(db,release.revisionId);
  need(!r.jsRecipe,'Historical JavaScript bisection requires fresh isolated execution');
  const built=build(db,r,{...release.input,expectedTarget:source});
  return {source,artifactDigest:built.artifactDigest,recipeDigest:built.recipeDigest,state:built.state,failures:built.validation.failures};
}
function landed(db,r,input){
  const row=db.prepare('SELECT record FROM native_landings WHERE revisionId=?').get(r.id),l=row&&JSON.parse(row.record);
  const e=l&&db.prepare('SELECT * FROM native_ref_events WHERE operationId=?').get(l.operationId);
  need(l&&l.candidate===input.expectedTarget&&l.generation===input.expectedGeneration&&e?.repository===r.repository&&
    e.name==='mainline'&&e.revisionId===l.candidate&&e.generation===l.generation,'Native release requires the exact accepted landing');
  return l;
}
export class NativeRelease {
  #tokens=new WeakMap();
  constructor(store,{authority,review}){this.store=store;this.db=store.db;this.native=new NativeStore(store);this.authority=authority;this.review=review;}
  #authorized(input){
    const r=this.review.view(input.revisionId).revision,a=this.authority();
    need(a&&r.repository===a.repository&&r.epoch===a.epoch&&r.policyDigest===a.policyDigest&&
      same(r.policy.allowedPaths,[...a.allowedPaths].sort())&&same(r.policy.checks,a.checks),'Native release authority or policy changed');
    const head=this.native.ref({repository:r.repository,name:'mainline'});
    need(head.revisionId===input.expectedTarget&&head.generation===input.expectedGeneration,'Native release target or generation changed');
    nativePrerequisites(this.db,r,{target:input.expectedTarget,generation:input.expectedGeneration});
    return {r,landing:landed(this.db,r,input)};
  }
  async prepareChecked(raw,javascript){
    const input=normalizeRelease(raw),{r}=this.#authorized(input);
    if(r.jsRecipe)await javascript.ensure(r.id);
    return this.prepare(input);
  }
  prepare(raw){
    const input=normalizeRelease(raw),{r,landing}=this.#authorized(input);
    const built=build(this.db,r,input,r.jsRecipe?jsLive(this.store,r):null),toolchain=currentToolchain(),token=Object.freeze({revisionId:r.id});
    this.#tokens.set(token,{input,landing,built,toolchain});return token;
  }
  candidate(token,operationId){
    need(this.db.isTransaction,'Native release acceptance requires owner writer transaction');
    const prepared=this.#tokens.get(token);need(prepared,'Expected prepared native release');
    const {input,landing,built,toolchain}=prepared,{r,landing:current}=this.#authorized(input);
    need(same(current,landing)&&(!r.jsRecipe||same(jsLive(this.store,r).evidence,built.recipe.javascript)),'Native release landing or isolated execution changed during preparation');
    const release={id:digest(['native-release-v1',r.repository,r.epoch,input,operationId]),operationId,revisionId:r.id,
      repository:r.repository,epoch:r.epoch,policyDigest:r.policyDigest,source:input.expectedTarget,generation:input.expectedGeneration,
      landingId:landing.operationId,reviewId:landing.reviewId,checkId:landing.checkId,input,artifactDigest:built.artifactDigest,artifactBytes:built.artifact.length,
      recipe:built.recipe,recipeDigest:built.recipeDigest,toolchain,toolchainDigest:digest(toolchain),validation:built.validation,state:built.state};
    const prior=this.db.prepare('SELECT record FROM native_release_candidates WHERE operationId=?').get(operationId);
    if(prior){need(same(release,JSON.parse(prior.record)),'Native release operation is bound to a different candidate');return {release};}
    need(this.db.prepare('SELECT count(*) n FROM native_release_candidates').get().n<256,'Native release candidate capacity exhausted');
    const artifact=this.db.prepare('SELECT bytes FROM native_release_artifacts WHERE digest=?').get(release.artifactDigest);
    if(artifact)need(built.artifact.equals(artifact.bytes),'Native artifact identity conflict');
    else{
      need(this.db.prepare('SELECT coalesce(sum(length(bytes)),0) n FROM native_release_artifacts').get().n+built.artifact.length<=16*1024*1024,'Native artifact retention capacity reached');
      this.db.prepare('INSERT INTO native_release_artifacts VALUES(?,?)').run(release.artifactDigest,built.artifact);
    }
    this.db.prepare('INSERT INTO native_release_candidates VALUES(?,?,?,?,?)').run(release.id,operationId,r.id,release.artifactDigest,JSON.stringify(release));
    return {release};
  }
  view({id}){
    validateNativeId(id);
    const row=this.db.prepare('SELECT record FROM native_release_candidates WHERE id=?').get(id);need(row,'Unknown native release candidate',404);
    const release=JSON.parse(row.record),a=this.authority(),head=this.native.ref({repository:release.repository,name:'mainline'});
    const applicable=a?.epoch===release.epoch&&a?.repository===release.repository&&a?.policyDigest===release.policyDigest&&
      head.revisionId===release.source&&head.generation===release.generation&&release.toolchainDigest===digest(currentToolchain());
    let dependenciesCurrent=true;
    try{
      const r=submission(this.db,release.revisionId);
      nativePrerequisites(this.db,r,{target:head.revisionId,generation:head.generation});
      if(r.jsRecipe){
        const fresh=jsLive(this.store,r).evidence,retained=release.recipe.javascript;
        dependenciesCurrent=fresh.state==='passed'&&['recipeId','sourceFileId','toolchainDigest','artifactDigest'].every(k=>fresh[k]===retained[k]);
      }
    }
    catch{dependenciesCurrent=false;}
    const failed=this.db.prepare("SELECT id FROM native_release_candidates WHERE revisionId=? AND json_extract(record,'$.state')='failed' ORDER BY rowid LIMIT 1").get(release.revisionId);
    return {release,eligible:applicable&&dependenciesCurrent&&!failed&&release.state==='passed',blockingFailure:failed?.id??null};
  }
  artifact({id}){
    const {release}=this.view({id}),row=this.db.prepare('SELECT bytes FROM native_release_artifacts WHERE digest=? AND length(bytes)=?').get(release.artifactDigest,release.artifactBytes);
    need(row&&sha(row.bytes)===release.artifactDigest,'Stored native release artifact digest mismatch');
    return {id,digest:release.artifactDigest,format:recipeVersion,base64:Buffer.from(row.bytes).toString('base64')};
  }
}

export function verifyNativeRelease(db){
  let releases=0,failed=0,edges=0;
  for(const row of db.prepare('SELECT record FROM native_submissions').iterate()){
    const r=JSON.parse(row.record);stored(db,r);nativePrerequisites(db,r,{historical:true});edges+=r.requires?.length??0;
    for(const entry of db.prepare('SELECT record FROM native_checks WHERE revisionId=?').iterate(r.id)){
      const c=JSON.parse(entry.record),proof=nativePrerequisites(db,r,{target:c.expectedTarget,generation:c.expectedGeneration,historical:true});
      need(same(c.prerequisites??[],proof),'Historical native prerequisite check evidence changed');
    }
    const entry=db.prepare('SELECT record FROM native_landings WHERE revisionId=?').get(r.id);
    if(entry){const l=JSON.parse(entry.record),proof=nativePrerequisites(db,r,{target:l.expectedTarget,generation:l.expectedGeneration,historical:true});
      need(same(l.prerequisites??[],proof),'Historical native prerequisite landing changed');}
  }
  for(const row of db.prepare('SELECT * FROM native_release_candidates').iterate()){
    const v=JSON.parse(row.record),input=normalizeRelease(v.input),r=submission(db,row.revisionId),l=landed(db,r,input),built=build(db,r,input,r.jsRecipe?jsHistoric(db,r,v.recipe?.javascript?.runId):null);
    const receipt=db.prepare('SELECT digest,receipt FROM command_receipts WHERE operationId=?').get(row.operationId);
    const data=db.prepare('SELECT bytes FROM native_release_artifacts WHERE digest=? AND length(bytes)=?').get(row.artifactDigest,built.artifact.length);
    need(v.operationId===row.operationId&&v.id===row.id&&v.revisionId===row.revisionId&&input.revisionId===r.id&&
      v.id===digest(['native-release-v1',r.repository,r.epoch,input,row.operationId])&&v.repository===r.repository&&v.epoch===r.epoch&&
      v.policyDigest===r.policyDigest&&v.source===input.expectedTarget&&v.generation===input.expectedGeneration&&
      v.landingId===l.operationId&&v.checkId===l.checkId&&v.reviewId===l.reviewId&&same(v.recipe,built.recipe)&&
      v.recipeDigest===built.recipeDigest&&same(v.validation,built.validation)&&v.state===built.state&&
      v.artifactDigest===built.artifactDigest&&row.artifactDigest===built.artifactDigest&&v.artifactBytes===built.artifact.length&&
      data&&built.artifact.equals(data.bytes),'Native release lost its exact source, artifact or validation evidence');
    need(v.toolchain?.builder===recipeVersion&&typeof v.toolchain.node==='string'&&/^v\d+\.\d+\.\d+$/.test(v.toolchain.node)&&
      [v.toolchain.implementation,v.toolchain.assertionEvaluator,v.toolchain.runtimeImageSha256].every(id=>/^[a-f0-9]{64}$/.test(id))&&v.toolchainDigest===digest(v.toolchain),
      'Native release toolchain provenance is incomplete');
    const saved=receipt&&JSON.parse(receipt.receipt);
    need(saved?.operationId===row.operationId&&same(saved.release,v)&&receipt.digest===digest(['release.prepare',input]),'Native release receipt or normalized owner intent changed');
    releases++;if(v.state==='failed')failed++;
  }
  need(!db.prepare('SELECT 1 FROM native_release_artifacts a LEFT JOIN native_release_candidates c ON a.digest=c.artifactDigest WHERE c.id IS NULL LIMIT 1').get()&&
    !db.prepare("SELECT 1 FROM command_receipts r LEFT JOIN native_release_candidates c ON c.operationId=r.operationId WHERE json_type(r.receipt,'$.release')='object' AND c.id IS NULL LIMIT 1").get(),
    'Native release receipt or artifact has no accountable candidate');
  return {releases,failed,edges};
}
