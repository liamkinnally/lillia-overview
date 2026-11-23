import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, rename, rm, realpath, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { privateRoot } from './installation-gate.mjs';
import { hostToolchain } from './project-validation-tools.mjs';
import { checkHash, requireCheck } from './project-workspace-check-catalog.mjs';

const digest = (value, algorithm = 'sha512') => createHash(algorithm).update(value).digest('hex');
const packagePath =
  /^(?:node_modules\/(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)(?:\/node_modules\/(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)*$/;
function platform(values, actual) {
  if (values === undefined) return true;
  requireCheck(
    Array.isArray(values) && values.every((x) => typeof x === 'string'),
    'Invalid locked package platform.'
  );
  return (
    !values.includes('!' + actual) &&
    (!values.some((x) => !x.startsWith('!')) || values.includes(actual))
  );
}
export function projectCheckDependencies(lockBytes) {
  const lock = JSON.parse(lockBytes);
  requireCheck(
    lock?.lockfileVersion === 3 &&
      lock.packages &&
      typeof lock.packages === 'object' &&
      lock.packages[''],
    'Project checks require npm lockfile version 3.'
  );
  const result = [],
    skipped = [];
  for (const path of Object.keys(lock.packages).filter(Boolean).sort()) {
    requireCheck(
      path.length <= 512 && packagePath.test(path) && !path.split('/').includes('..'),
      'Unsafe locked dependency path.'
    );
    const entry = lock.packages[path];
    requireCheck(
      entry && typeof entry === 'object' && !entry.link,
      'Linked or missing dependencies are unsupported.'
    );
    if (
      skipped.some((parent) => path.startsWith(parent + '/node_modules/')) ||
      !platform(entry.os, 'darwin') ||
      !platform(entry.cpu, 'arm64')
    ) {
      skipped.push(path);
      continue;
    }
    // Bundled files are authenticated by the enclosing package archive, never fetched separately.
    if (entry.inBundle) {
      requireCheck(
        result.some((parent) => path.startsWith(parent.path + '/node_modules/')),
        'Unbound bundled dependency.'
      );
      continue;
    }
    requireCheck(
      typeof entry.integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity),
      'Every installed dependency requires its locked SHA-512 archive integrity.'
    );
    result.push({ path, sha512: Buffer.from(entry.integrity.slice(7), 'base64').toString('hex') });
    requireCheck(result.length <= 2048, 'The project dependency set exceeds its check profile.');
  }
  return result;
}
async function regular(path, max, allowEmpty = false) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    requireCheck(
      before.isFile() && (allowEmpty || before.size > 0) && before.size <= max,
      'Dependency cache input is not a bounded regular file.'
    );
    const bytes = await fd.readFile();
    const after = await fd.stat();
    requireCheck(
      bytes.length === before.size &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs,
      'Dependency cache input changed during inspection.'
    );
    return bytes;
  } finally {
    await fd.close();
  }
}
export function workspaceCheckCache(dataDir) {
  return join(privateRoot(dataDir), 'project-workspace-check-cache');
}
export async function prepareCheckArchives(
  dataDir,
  dependencies,
  npmCache = join(homedir(), '.npm', '_cacache', 'content-v2', 'sha512')
) {
  const cache = workspaceCheckCache(dataDir);
  await mkdir(cache, { recursive: true, mode: 0o700 });
  privateRoot(cache);
  let total = 0;
  for (const entry of dependencies) {
    const dest = join(cache, entry.sha512);
    try {
      const bytes = await regular(dest, 128 * 1024 * 1024);
      requireCheck(digest(bytes) === entry.sha512, 'Prepared dependency cache integrity differs.');
      total += bytes.length;
      requireCheck(
        total <= 1024 * 1024 * 1024,
        'Dependency archives exceed the 1 GiB cache bound.'
      );
      continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const source = join(
      npmCache,
      entry.sha512.slice(0, 2),
      entry.sha512.slice(2, 4),
      entry.sha512.slice(4)
    );
    let bytes;
    try {
      requireCheck(
        (await realpath(source)) === source,
        'Dependency archive path is not canonical.'
      );
      bytes = await regular(source, 128 * 1024 * 1024);
    } catch (error) {
      if (error.code === 'ENOENT')
        throw Object.assign(
          new Error('The pinned npm archive is unavailable locally: ' + entry.path),
          { status: 409 }
        );
      throw error;
    }
    requireCheck(
      digest(bytes) === entry.sha512,
      'Dependency archive does not match its retained lock.'
    );
    total += bytes.length;
    requireCheck(total <= 1024 * 1024 * 1024, 'Dependency archives exceed the 1 GiB cache bound.');
    const temp = join(cache, '.prepare-' + randomUUID());
    try {
      const fd = await open(temp, 'wx', 0o600);
      try {
        await fd.writeFile(bytes);
        await fd.sync();
      } finally {
        await fd.close();
      }
      await rename(temp, dest);
    } finally {
      await rm(temp, { force: true });
    }
  }
  return {
    directory: cache,
    archiveCount: dependencies.length,
    archiveBytes: total,
    dependenciesDigest: checkHash(JSON.stringify(dependencies))
  };
}

export async function checkRuntimeTreeDigest(root) {
  const entries = [];
  async function walk(directory, relative = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1
    )) {
      const path = join(directory, entry.name),
        name = relative + entry.name;
      requireCheck(!entry.isSymbolicLink(), 'The enrolled npm runtime contains a symbolic link.');
      if (entry.isDirectory()) await walk(path, name + '/');
      else {
        requireCheck(entry.isFile() && entries.length < 6000, 'Unsupported npm runtime inventory.');
        entries.push([name, checkHash(await regular(path, 8 * 1024 * 1024, true))]);
      }
    }
  }
  await walk(root);
  return checkHash(JSON.stringify(entries));
}
export async function workspaceCheckToolchain() {
  await hostToolchain();
  const npm = await realpath(join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm'));
  const npmCli = join(npm, 'bin', 'npm-cli.js');
  const npmDigest = await checkRuntimeTreeDigest(npm);
  const engine = await Promise.all(
    [
      './project-workspace-check-cache.mjs',
      './project-workspace-check-catalog.mjs',
      './project-workspace-check-runner.mjs',
      './project-workspace-checks.mjs'
    ].map(async (name) => [name, checkHash(await readFile(new URL(name, import.meta.url)))])
  );
  return {
    version: 1,
    node: process.version,
    nodeDigest: checkHash(await readFile(process.execPath)),
    npmDigest,
    shellDigest: checkHash(await readFile('/bin/bash')),
    engineDigest: checkHash(JSON.stringify(engine)),
    npmDirectory: npm,
    npmCli
  };
}

export const unpackCheckArchives = String.raw`import hashlib,io,json,os,pathlib,stat,sys,tarfile
root=pathlib.Path.cwd().resolve()
cache=pathlib.Path(sys.argv[1])
total=0
count=0
packages=json.load(sys.stdin)
for package in packages:
 name=package['path'];digest=package['sha512']
 assert name.startswith('node_modules/') and '..' not in pathlib.PurePosixPath(name).parts
 assert len(digest)==128 and all(c in '0123456789abcdef' for c in digest)
 fd=os.open(cache/digest,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 with os.fdopen(fd,'rb') as f:
  info=os.fstat(f.fileno());assert stat.S_ISREG(info.st_mode) and 0<info.st_size<=128*1024**2
  blob=f.read(info.st_size+1);assert len(blob)==info.st_size and hashlib.sha512(blob).hexdigest()==digest
 with tarfile.open(fileobj=io.BytesIO(blob),mode='r:gz') as tar:
  for item in tar:
   parts=pathlib.PurePosixPath(item.name).parts
   assert parts and not item.name.startswith('/') and '..' not in parts and len(parts)<=48
   if item.isdir() or len(parts)==1:continue
   assert item.isfile()
   count+=1;total+=item.size
   assert count<=150000 and item.size<=256*1024**2 and total<=2*1024**3
   path=root/name/pathlib.Path(*parts[1:]);path.parent.mkdir(exist_ok=True,parents=True)
   content=tar.extractfile(item).read();assert len(content)==item.size
   if path.exists():assert path.read_bytes()==content
   else:
    with path.open('xb') as out:out.write(content)
   path.chmod(0o500 if item.mode&0o111 else 0o400)
for package in packages:
 directory=root/package['path'];manifest=directory/'package.json'
 if not manifest.exists():continue
 data=json.loads(manifest.read_text());bins=data.get('bin',{})
 if isinstance(bins,str):bins={data.get('name','').split('/')[-1]:bins}
 assert isinstance(bins,dict)
 for name,target in bins.items():
  assert name and all(c.isalnum() or c in '-_.' for c in name) and name not in ('.','..')
  assert isinstance(target,str) and not target.startswith('/') and '..' not in pathlib.PurePosixPath(target).parts
  source=(directory/target).resolve();assert source.is_file() and directory in source.parents
  source.chmod(0o500)
  parent=directory.parent
  if parent.name.startswith('@'):parent=parent.parent
  dest=parent/'.bin'/name;dest.parent.mkdir(exist_ok=True)
  if not dest.exists():dest.symlink_to(os.path.relpath(source,dest.parent))
print(json.dumps({'files':count,'bytes':total}))
`;
