import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * The TypeScript union and the database CHECK must agree.
 *
 * They did not, and the gap cost every re-clip cost row since the feature
 * shipped: TypeScript accepted 'reclip', Postgres refused it, and
 * recordModelUsage swallowed the rejection as a warning. Nothing failed
 * loudly; the data simply never arrived, and a dashboard reported the absence
 * as a number.
 *
 * This test exists so the two can never drift apart silently again — it reads
 * both sources and compares them, rather than trusting either alone.
 */

const root = path.resolve(__dirname, '..');

function unionFromTypeScript(): string[] {
  const source = readFileSync(path.join(root, 'src/db/repositories/usage.ts'), 'utf8');
  const line = source.match(/export type UsageStage\s*=\s*([^;]+);/);
  if (!line) throw new Error('UsageStage union not found — the guard cannot check what it cannot read');
  return [...line[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
}

/**
 * Comments are stripped first. The fix migration QUOTES the old constraint in
 * its own explanation, and reading that instead of the live statement is
 * exactly how this guard would come to certify the bug it exists to catch —
 * which is what it did on first run.
 */
function statementsOnly(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

function allowedByDatabase(): string[] {
  // The LAST migration that touches the constraint is the one in force.
  const dir = path.join(root, 'src/db/migrations');
  const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort();
  const withConstraint = files.filter((file) =>
    /CHECK \(stage IN/.test(statementsOnly(readFileSync(path.join(dir, file), 'utf8'))),
  );
  const last = withConstraint.at(-1);
  if (!last) throw new Error('no migration defines the stage constraint');
  const sql = statementsOnly(readFileSync(path.join(dir, last), 'utf8'));
  const check = sql.match(/CHECK \(stage IN \(([^)]+)\)\)/);
  if (!check) throw new Error(`no stage CHECK found in ${last}`);
  return [...check[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
}

describe('UsageStage stays synchronized with the database CHECK', () => {
  it('every TypeScript stage is accepted by the database', () => {
    const ts = unionFromTypeScript();
    const db = allowedByDatabase();
    const rejected = ts.filter((stage) => !db.includes(stage));
    // This is exactly what broke: 'reclip' in the union, absent from the CHECK.
    expect(rejected).toEqual([]);
  });

  it("'reclip' is accepted — the stage whose rows were being dropped", () => {
    expect(allowedByDatabase()).toContain('reclip');
    expect(unionFromTypeScript()).toContain('reclip');
  });

  it("'composition' is accepted, ready for the post-ready media work", () => {
    expect(allowedByDatabase()).toContain('composition');
  });

  it('the stages that always worked still do', () => {
    const db = allowedByDatabase();
    for (const stage of ['transcription', 'indexing', 'search']) expect(db).toContain(stage);
  });

  it('retains verification rather than dropping a pre-existing value', () => {
    expect(allowedByDatabase()).toContain('verification');
  });
});
