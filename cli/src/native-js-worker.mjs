import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { release } from 'node:os';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const invalid = (message) => {
  throw Object.assign(new Error(message), { status: 400 });
};
const lexical =
  /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|'use strict'|"use strict"|[a-zA-Z_][a-zA-Z0-9_]*|(?:0|[1-9]\d*)(?:\.\d+)?|\+\+|--|\*\*|===|!==|<=|>=|&&|\|\||[(){};,.=+*/%<>!?:-]/gy;
const identifier = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const forbidden = new Set(
  'arguments await break case catch class const constructor continue debugger default delete do else enum eval export exports extends false finally for function globalThis if implements import in instanceof interface let module new null package private process protected prototype public require return static super switch this throw true try typeof var void while with yield'.split(
    ' '
  )
);
const validName = (name) =>
  typeof name === 'string' && identifier.test(name) && !forbidden.has(name);
const operators = new Set('+ - * / % < <= > >= === !== && ||'.split(' '));
const scalar = (x) => typeof x === 'boolean' || (Number.isFinite(x) && Math.abs(x) <= 1e12);
export const portableProfile = 'portable-scalar-commonjs-v1';

export function validateJsCases(exportName, cases) {
  if (!validName(exportName) || !Array.isArray(cases) || cases.length < 1 || cases.length > 8)
    invalid('Invalid portable export or case count');
  for (const c of cases) {
    if (
      !c ||
      Object.keys(c).sort().join(',') !== 'args,expected' ||
      !Array.isArray(c.args) ||
      c.args.length > 8 ||
      c.args.length !== cases[0].args.length ||
      !c.args.every(scalar) ||
      !scalar(c.expected)
    )
      invalid('Invalid scalar test case');
  }
  return { exportName, cases: cases.map((c) => ({ args: [...c.args], expected: c.expected })) };
}
export function validateJsModule(bytes, exportName) {
  if (!validName(exportName) || !Buffer.isBuffer(bytes) || bytes.length > 4096)
    invalid('Invalid module size or export');
  const source = bytes.toString('utf8');
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(source)) invalid('Module must be ASCII JavaScript');
  const tokens = [];
  lexical.lastIndex = 0;
  while (lexical.lastIndex < source.length) {
    const token = lexical.exec(source)?.[0];
    if (!token || tokens.length > 256) invalid('Unsupported module token or length');
    if (!/^\s|^\/\/|^\/\*/.test(token)) tokens.push(token);
  }
  let at = 0;
  const peek = () => tokens[at];
  const accept = (x) => peek() === x && (++at, true);
  const expect = (x) => {
    if (!accept(x)) invalid('Expected ' + x + ' in the portable module');
  };
  const names = new Set();
  function name() {
    const value = tokens[at++];
    if (!validName(value) || names.has(value)) invalid('Unsupported or repeated scalar variable');
    return value;
  }
  function primary(depth) {
    if (depth > 32) invalid('Expression depth exceeds the scalar profile');
    if (accept('(')) {
      expression(depth + 1);
      expect(')');
      return;
    }
    if (['+', '-', '!'].includes(peek())) {
      at++;
      primary(depth + 1);
      return;
    }
    const atom = tokens[at++];
    if (
      !(
        atom === 'true' ||
        atom === 'false' ||
        names.has(atom) ||
        (/^\d/.test(atom ?? '') && scalar(Number(atom)))
      )
    )
      invalid('Expected a declared scalar or literal');
  }
  function expression(depth = 0) {
    primary(depth);
    while (operators.has(peek())) {
      at++;
      primary(depth);
    }
    if (accept('?')) {
      expression(depth + 1);
      expect(':');
      expression(depth + 1);
    }
  }
  if (accept("'use strict'") || accept('"use strict"')) expect(';');
  for (const t of ['module', '.', 'exports', '.', exportName, '=', 'function', '(']) expect(t);
  const parameters = [];
  if (peek() !== ')')
    do {
      const p = name();
      names.add(p);
      parameters.push(p);
    } while (accept(','));
  if (parameters.length > 8) invalid('Too many scalar parameters');
  expect(')');
  expect('{');
  while (peek() === 'const' || peek() === 'if') {
    if (accept('const')) {
      if (names.size >= 24) invalid('Too many scalar variables');
      const p = name();
      expect('=');
      expression();
      expect(';');
      names.add(p);
    } else {
      expect('if');
      expect('(');
      expression();
      expect(')');
      expect('return');
      expression();
      expect(';');
    }
  }
  expect('return');
  expression();
  expect(';');
  expect('}');
  accept(';');
  if (at !== tokens.length) invalid('Unexpected JavaScript after the sole export');
  return { parameters };
}

const policy =
  '(version 1)(deny default)(import "dyld-support.sb")(allow sysctl-read)(allow process-exec (literal (param "runtime")))(allow file-read* file-map-executable (literal (param "runtime")) (subpath "/usr/lib"))(allow file-read* (literal "/dev/null") (literal "/dev/urandom"))(allow file-write-data (literal "/dev/null"))';
const loaderDigest = '06215a5d32689aefe395c29710e182eb54ba22162f50df8b4842290f8a19bf1c';
const flags = [
  '--openssl-config=/dev/null',
  '--jitless',
  '--no-addons',
  '--no-global-search-paths',
  '--max-old-space-size=24',
  '--max-semi-space-size=1',
  '--stack_size=512',
  '--random-seed=71',
  '--no-lazy'
];
const program = `const vm=require('node:vm');
let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>raw+=s);process.stdin.on('end',async()=>{
const p=JSON.parse(raw),opts={filename:'portable.cjs'},source=p.source;
let data;
const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process'),net=require('node:net');
const runtimeHash=crypto.createHash('sha256'),fd=fs.openSync(process.execPath,'r'),block=Buffer.alloc(65536);
for(let n;(n=fs.readSync(fd,block,0,block.length,null));)runtimeHash.update(block.subarray(0,n));fs.closeSync(fd);
const runtimeDigest=runtimeHash.digest('hex');
const denied=fn=>{try{fn();return false;}catch(e){return ['EPERM','EACCES'].includes(e.code);}};
const netDenied=addr=>new Promise(resolve=>{const socket=net.connect(addr);socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',e=>resolve(['EPERM','EACCES'].includes(e.code)));});
const confinement={emptyEnvironment:Object.keys(process.env).length===0,readDenied:denied(()=>fs.readFileSync(p.fixture)),writeDenied:denied(()=>fs.appendFileSync(p.fixture,'x')),
 forkDenied:['EPERM','EACCES'].includes(cp.spawnSync(process.execPath,['--version']).error?.code),networkDenied:await netDenied({host:'127.0.0.1',port:9}),socketDenied:await netDenied({path:p.fixture+'.socket'})};
if(!Object.values(confinement).every(Boolean))throw Error('Host confinement probe failed '+JSON.stringify(confinement));
if(p.mode==='build'){data={cachedData:new vm.Script(source,opts).createCachedData().toString('base64')};}
else {const outputs=[];for(const args of p.args){
const ctx=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
vm.runInContext('var module={exports:Object.create(null)};',ctx);
const compiled=new vm.Script(source,{...opts,cachedData:Buffer.from(p.cachedData,'base64')});
if(compiled.cachedDataRejected)throw Error('cache rejected');
compiled.runInContext(ctx,{timeout:100});const out=vm.runInContext('module.exports['+JSON.stringify(p.name)+']('+args.map(x=>JSON.stringify(x)).join(',')+')',ctx,{timeout:100});
outputs.push(typeof out==='boolean'||Number.isFinite(out)&&Math.abs(out)<=1e12?out:null);
}data={outputs};}
process.stdout.write(JSON.stringify({...data,runtimeDigest,confinement,maxRSS:process.resourceUsage().maxRSS}));
});`;
function child(runtime, cwd, input) {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      '/usr/bin/sandbox-exec',
      ['-D', 'runtime=' + runtime, '-p', policy, runtime, ...flags, '-e', program],
      { cwd, env: {}, encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 65536 },
      (error, stdout) => {
        if (error)
          return reject(
            Object.assign(new Error('The isolated Node worker could not finish'), {
              status: 409,
              cause: error
            })
          );
        try {
          const out = JSON.parse(stdout);
          if (!Number.isSafeInteger(out.maxRSS) || out.maxRSS > 131072)
            invalid('Worker exceeded accepted peak RSS');
          resolve(out);
        } catch (e) {
          reject(e);
        }
      }
    );
    proc.stdin.on('error', () => {});
    proc.stdin.end(JSON.stringify({ ...input, fixture: join(cwd, 'private-fixture') }));
  });
}
export async function runJsModule({ source, exportName, cases }) {
  validateJsCases(exportName, cases);
  const { parameters } = validateJsModule(source, exportName);
  if (parameters.length !== cases[0].args.length)
    invalid('The export arity differs from the owner cases');
  if (
    process.platform !== 'darwin' ||
    process.arch !== 'arm64' ||
    release() !== '25.3.0' ||
    process.version !== 'v24.22.2' ||
    digest(await readFile('/System/Library/Sandbox/Profiles/dyld-support.sb')) !== loaderDigest
  )
    throw Object.assign(new Error('Unsupported isolated Node execution host'), { status: 409 });
  const cwd = await mkdtemp('/private/tmp/lillia-js-');
  const listener = createServer((s) => s.destroy());
  try {
    await new Promise((resolve, reject) =>
      listener.once('error', reject).listen(join(cwd, 'private-fixture.socket'), resolve)
    );
    await writeFile(join(cwd, 'private-fixture'), 'unrelated fixture', { mode: 0o600 });
    const runtime = await realpath(process.execPath);
    const toolchain = {
      profile: portableProfile,
      node: process.version,
      v8: process.versions.v8,
      host: release(),
      runtimeDigest: digest(await readFile(runtime)),
      policyDigest: digest(policy),
      loaderDigest,
      runnerDigest: digest(program),
      flags
    };
    const {
      cachedData,
      runtimeDigest: compilerDigest,
      maxRSS: buildRSS
    } = await child(runtime, cwd, { mode: 'build', source: source.toString() });
    const artifact = Buffer.from(cachedData, 'base64');
    if (!artifact.length || artifact.length > 32768) invalid('Invalid build artifact size');
    const {
      outputs,
      confinement,
      runtimeDigest: testDigest,
      maxRSS: testRSS
    } = await child(runtime, cwd, {
      mode: 'test',
      source: source.toString(),
      name: exportName,
      args: cases.map((c) => c.args),
      cachedData
    });
    if (testDigest !== toolchain.runtimeDigest || compilerDigest !== testDigest)
      throw Object.assign(new Error('Worker runtime changed during validation'), { status: 409 });
    if (!Array.isArray(outputs) || outputs.length !== cases.length)
      invalid('Incomplete test output');
    const failures = cases.flatMap((c, i) => (c.expected === outputs[i] ? [] : [i]));
    return {
      state: failures.length ? 'failed' : 'passed',
      outputs,
      failures,
      cachedData,
      artifactDigest: digest(artifact),
      sourceDigest: digest(source),
      toolchain,
      confinement,
      toolchainDigest: digest(JSON.stringify(toolchain)),
      peakRSSKiB: Math.max(buildRSS, testRSS)
    };
  } finally {
    if (listener.listening) await new Promise((resolve) => listener.close(resolve));
    await rm(cwd, { recursive: true, force: true });
  }
}
