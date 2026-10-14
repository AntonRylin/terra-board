// Background removal (onnxruntime) needs the Visual C++ runtime, which Windows
// does not include by default. Copy it next to onnxruntime.dll in the package
// ("app-local" deployment) so the app works on PCs without the redistributable.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const files = [
  'msvcp140.dll',
  'msvcp140_1.dll',
  'msvcp140_atomic_wait.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
];
const target = fileURLToPath(new URL('../build/vc-runtime/', import.meta.url));
const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
mkdirSync(target, { recursive: true });
for (const name of files) {
  const source = join(system, name);
  if (!existsSync(source))
    throw Error(
      `${name} is missing. Install the Microsoft Visual C++ 2015-2022 Redistributable (x64) on this build machine.`,
    );
  copyFileSync(source, join(target, name));
}
console.log(`Copied ${files.length} Visual C++ runtime files to build/vc-runtime`);
