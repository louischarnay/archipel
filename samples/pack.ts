// Prepares the sample app archives, to drop into "Add an app".
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { create } from 'tar';

const root = fileURLToPath(new URL('.', import.meta.url));
mkdirSync(`${root}dist`, { recursive: true });

for (const name of ['customers', 'tickets']) {
  await create({ gzip: true, file: `${root}dist/${name}.tar.gz`, cwd: `${root}${name}` }, ['.']);
  console.log(`samples/dist/${name}.tar.gz`);
}
