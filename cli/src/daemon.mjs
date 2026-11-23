import { startService } from './local-service.mjs';
import { openPlatform } from './platform.mjs';

process.umask(0o077);
try {
  const [dataDir, workspaceRoot, profile] = process.argv.slice(2);
  const requestedProfile = profile === undefined ? undefined : JSON.parse(profile);
  const service = await startService({ dataDir, workspaceRoot, openPlatform, requestedProfile });
  const shutdown = () =>
    service.close().catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.send?.({ ready: true }, () => {});
} catch (error) {
  if (process.send)
    process.send({ error: error.message, code: error.code, status: error.status }, () => {});
  else console.error(error.message);
  process.exitCode = 1;
}
