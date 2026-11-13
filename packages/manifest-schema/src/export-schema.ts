import { writeFileSync } from 'node:fs';
import { manifestSchema } from './schema.js';

// `npm run schema`: the file published for agents and editors. A test checks that it stays up to date.
writeFileSync(new URL('../app.manifest.schema.json', import.meta.url), `${JSON.stringify(manifestSchema, null, 2)}\n`);
