import {createHash} from 'node:crypto';

function valid(ok,message) {
  if(!ok) throw Object.assign(new Error(message),{status:400});
}
function exact(obj,keys){
  return obj && typeof obj==='object' && !Array.isArray(obj) && Object.keys(obj).length===keys.length &&
    keys.every(k=>Object.hasOwn(obj,k));
}
function location({path,pointer}){
  valid(typeof path==='string' && path.length<=240 && path.endsWith('.json') && path.split('/').every(p=>
    /^[A-Za-z0-9_.-]+$/.test(p)&&p!=='.'&&p!=='..'&&p.toLowerCase()!=='.git'),'Recipe references must name exact portable JSON paths');
  valid(typeof pointer==='string' && pointer.length<=256 && (pointer==='' || pointer.startsWith('/')) &&
    !/~(?:[^01]|$)/.test(pointer) && pointer.split('/').length<=17,'Invalid bounded JSON Pointer');
  return {path,pointer};
}

export function makeReviewRecipe(projectId,initial,items) {
  valid(Array.isArray(items)&&items.length<=16,'Choose at most 16 declarative candidate assertions');
  const checks=items.map(rule=>{
    if(rule?.kind==='json-equals' && exact(rule,['kind','path','pointer','value'])){
      valid(rule.value===null || typeof rule.value==='boolean' || Number.isFinite(rule.value) ||
        (typeof rule.value==='string' && rule.value.length<=2048),'Expected a bounded JSON scalar');
      return {kind:rule.kind,...location(rule),value:rule.value};
    }
    valid(rule?.kind==='json-number-lte' && exact(rule,['kind','left','right']) && exact(rule.left,['path','pointer']) &&
      exact(rule.right,['path','pointer']),'Unknown or invalid declarative candidate assertion');
    return {kind:rule.kind,left:location(rule.left),right:location(rule.right)};
  });
  const recipeVersion=1;
  const recipeDigest=createHash('sha256').update(JSON.stringify({version:recipeVersion,projectId,initial,checks})).digest('hex');
  return {recipeVersion,recipeDigest,checks};
}

export function evaluateReviewRecipe(db,candidate,checks) {
  const read=db.prepare(`SELECT p.mode,length(b.bytes) AS size,b.bytes FROM git_paths p
    JOIN git_blobs b ON b.oid=p.oid WHERE p.revision=? AND p.path=? AND length(b.bytes)<=131072`);
  return evaluateFileRecipe(path=>read.get(candidate,path),checks);
}

export function evaluateFileRecipe(readFile,checks) {
  const cache=new Map(),missing=Symbol('absent');
  function get(ref) {
    if(!cache.has(ref.path)) {
      const row=readFile(ref.path);let value=missing;
      if(row && row.bytes.length<=131072 && ['100644','100755'].includes(row.mode)) {
        try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(row.bytes));}catch{}
      }
      cache.set(ref.path,value);
    }
    let value=cache.get(ref.path);
    for(const raw of ref.pointer.split('/').slice(1)) {
      const key=raw.replaceAll('~1','/').replaceAll('~0','~');
      if(value===null || typeof value!=='object' || !Object.hasOwn(value,key) ||
        (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key))) return missing;
      value=value[key];
    }
    return value;
  }
  const failures=[];
  checks.forEach((check,index)=>{
    let ok;
    if(check.kind==='json-equals') ok=get(check)===check.value;
    else {
      const left=get(check.left),right=get(check.right);
      ok=Number.isFinite(left) && Number.isFinite(right) && left<=right;
    }
    if(!ok) failures.push({index,kind:check.kind,reason:'The declared assertion failed on the exact candidate JSON inputs.'});
  });
  return failures;
}
