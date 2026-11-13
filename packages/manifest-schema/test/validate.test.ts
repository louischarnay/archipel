import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateTypes, parseManifest, validateManifest, type Manifest } from '../src/index.js';

const root = mkdtempSync(join(tmpdir(), 'archipel-manifest-'));
writeFileSync(join(root, 'close.js'), 'export default () => null;\n');

const base = { manifest: 1, id: 'demo', name: 'Demo', version: '1.0.0' };
const table = { columns: { id: { type: 'uuid', pk: true }, title: { type: 'string', required: true } } };
const errorsOf = (manifest: unknown) => validateManifest(manifest, root).errors;

describe('manifest errors', () => {
  it('gives the path, the received value, the expected value and a fix', () => {
    const [error] = errorsOf({ ...base, id: 'Demo App' });
    expect(error).toMatchObject({ path: 'id', received: 'Demo App' });
    expect(error?.expected).toBeDefined();
    expect(error?.hint).toBeTruthy();
  });

  it('suggests the intended field for a typo', () => {
    const [error] = errorsOf({ ...base, vesion: '1.0.0' });
    expect(error?.message).toContain('vesion');
    expect(error?.hint).toContain('version');
  });

  it('reports an unknown column type with the allowed types', () => {
    const [error] = errorsOf({
      ...base,
      tables: { ticket: { columns: { id: { type: 'uuid', pk: true }, at: { type: 'strng' } } } },
    });
    expect(error?.path).toBe('tables.ticket.columns.at.type');
    expect(JSON.stringify(error?.expected)).toContain('string');
    expect(error?.hint).toContain('string');
  });

  it('truncates a received value that is too long', () => {
    const [error] = errorsOf({ ...base, id: 'x'.repeat(5000) });
    expect(JSON.stringify(error?.received).length).toBeLessThan(300);
  });

  it('reports unreadable YAML without throwing', () => {
    const { errors } = parseManifest('id: [');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.hint).toBeTruthy();
  });

  it('rejects a route reserved by the platform', () => {
    const errors = errorsOf({ ...base, frontend: { dir: './web', route: '/api' } });
    expect(errors.map(({ path }) => path)).toContain('frontend.route');
  });

  it('rejects a controller that imports the SDK at runtime', () => {
    writeFileSync(join(root, 'bad.js'), "import { x } from '@archipel/sdk';\nexport default () => x;\n");
    const controllers = [{ path: 'POST /x', handler: './bad.js' }];
    expect(errorsOf({ ...base, controllers })[0]?.hint).toBeTruthy();
  });

  it('accepts a complete manifest', () => {
    const controllers = [{ path: 'POST /tickets/:id/close', handler: './close.js', needs: ['ticket.write'] }];
    expect(errorsOf({ ...base, tables: { ticket: { ...table, crud: true } }, controllers })).toEqual([]);
  });
});

describe('types derived from tables:', () => {
  it('makes columns required or optional on insert', () => {
    const types = generateTypes({ ...base, tables: { ticket: table } } as unknown as Manifest);
    expect(types).toContain('export interface Ticket');
    expect(types).toContain('TicketInsert');
    expect(types).toMatch(/title: string/);
  });
});
