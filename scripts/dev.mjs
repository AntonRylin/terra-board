import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const server = await createServer();
await server.listen();
const env = { ...process.env, CANVAS_DEV_URL: 'http://127.0.0.1:5173' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['.'], { stdio: 'inherit', env });
child.on('exit', async () => {
  await server.close();
  process.exit();
});
