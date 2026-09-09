import { createHash } from 'node:crypto';
import { Client, escapeIdentifier, type QueryResultRow } from 'pg';

export type FixtureIdentityErrorCode = 'unsupported' | 'budget-exceeded' | 'not-quiescent' | 'aborted' | 'database-error';
export class FixtureIdentityError extends Error {
  constructor(readonly code: FixtureIdentityErrorCode, message: string) { super(message); this.name = 'FixtureIdentityError'; }
}
export interface FixtureIdentityOptions {
  maxObjects?: number;
  maxRows?: number;
  /** Total canonical bytes hashed, including catalog definitions and row values. */
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface FixtureIdentity {
  version: 1;
  profile: 'postgresql16-native-v1';
  algorithm: 'sha256';
  fingerprint: string;
  components: { schema: string; data: string; sequences: string; settings: string };
  counts: { objects: number; rows: number; bytes: number };
}
const userNamespace = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'";
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
// NULL means an object's default privileges; an empty ACL means none. Preserve both.
const canonicalAcl = (column: string): string => `CASE WHEN ${column} IS NULL THEN NULL ELSE ARRAY(SELECT x::text FROM unnest(${column}) x ORDER BY x::text) END`;
function limit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`${name} must be an integer from 1 to ${maximum}`);
  return result;
}
/** PG16 pg_split_opts + getopt semantics; quotes are literal, backslashes escape. */
function startupSettingNames(options: string): string[] {
  const words: string[] = [];
  let word = '';
  for (let i = 0; i < options.length; i++) {
    const char = options[i]!;
    if (char === '\\' && i + 1 < options.length) word += options[++i];
    else if (/[ \t\n\r\f\v]/.test(char)) { if (word) { words.push(word); word = ''; } }
    else word += char;
  }
  if (word) words.push(word);
  const names = new Set<string>();
  const optionSpec = 'B:bC:c:D:d:EeFf:h:ijk:lN:nOPp:r:S:sTt:v:W:-:';
  const unsupported = () => new FixtureIdentityError('unsupported', 'Fixture identity cannot parse these PostgreSQL startup options');
  for (let i = 0; i < words.length; i++) {
    const token = words[i]!;
    if (!token.startsWith('-') || token === '-' || token === '--') throw unsupported();
    for (let at = 1; at < token.length; at++) {
      const flag = token[at]!;
      const flagIndex = optionSpec.indexOf(flag);
      if (flag === ':' || flagIndex < 0) throw unsupported();
      if (optionSpec[flagIndex + 1] !== ':') continue;
      const argument = token.slice(at + 1) || words[++i];
      if (argument === undefined) throw unsupported();
      if (flag === 'c' || flag === '-') {
        const equal = argument.indexOf('=');
        if (equal <= 0) throw unsupported();
        // PostgreSQL folds only ASCII; Unicode lowercasing would merge distinct names.
        names.add(argument.slice(0, equal).replace(/-/g, '_').replace(/[A-Z]/g, c => c.toLowerCase()));
      }
      break;
    }
  }
  return [...names];
}

// Relevant principals include fixture owners and ACL principals, then their inherited roles.
// Unrelated cluster roles must not make otherwise identical disposable fixtures differ.
const relevantRoles = `WITH RECURSIVE fixture_acl(acl) AS (
  SELECT n.nspacl FROM pg_namespace n WHERE ${userNamespace}
  UNION ALL SELECT c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${userNamespace}
  UNION ALL SELECT p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${userNamespace}
  UNION ALL SELECT t.typacl FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${userNamespace}
  UNION ALL SELECT a.attacl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${userNamespace}
  UNION ALL SELECT defaclacl FROM pg_default_acl
  UNION ALL SELECT lanacl FROM pg_language WHERE lanname IN ('sql','plpgsql')
  UNION ALL SELECT datacl FROM pg_database WHERE datname=current_database()
), principals(id) AS (
  SELECT oid FROM pg_roles WHERE rolname=current_user
  UNION SELECT datdba FROM pg_database WHERE datname=current_database()
  UNION SELECT n.nspowner FROM pg_namespace n WHERE ${userNamespace}
  UNION SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${userNamespace}
  UNION SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${userNamespace}
  UNION SELECT t.typowner FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${userNamespace}
  UNION SELECT c.collowner FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE ${userNamespace}
  UNION SELECT defaclrole FROM pg_default_acl
  UNION SELECT lanowner FROM pg_language WHERE lanname IN ('sql','plpgsql')
  UNION SELECT x.grantee FROM fixture_acl a CROSS JOIN LATERAL aclexplode(a.acl) x
  UNION SELECT x.grantor FROM fixture_acl a CROSS JOIN LATERAL aclexplode(a.acl) x
  UNION SELECT unnest(p.polroles) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${userNamespace}
), relevant(id) AS (
  SELECT id FROM principals UNION SELECT m.roleid FROM pg_auth_members m JOIN relevant r ON r.id=m.member
)`;

const schemaQueries: Record<string, string> = {
  schemas: `SELECT n.nspname, pg_get_userbyid(n.nspowner) AS owner,
    ${canonicalAcl('n.nspacl')} AS acl
    FROM pg_namespace n WHERE ${userNamespace}`,
  relations: `SELECT n.nspname, c.relname, c.relkind, c.relpersistence, c.relreplident,
    c.relrowsecurity, c.relforcerowsecurity, c.relispopulated, c.relispartition,
    pg_get_userbyid(c.relowner) AS owner, am.amname AS access_method,
    ts.spcname AS tablespace, format_type(c.reloftype,NULL) AS typed_table,
    ARRAY(SELECT x FROM unnest(c.reloptions) x ORDER BY x) AS options,
    ${canonicalAcl('c.relacl')} AS acl,
    CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,false) END AS view_definition,
    CASE WHEN c.relkind='p' THEN pg_get_partkeydef(c.oid) END AS partition_key,
    pg_get_expr(c.relpartbound,c.oid,false) AS partition_bound
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_am am ON am.oid=c.relam LEFT JOIN pg_tablespace ts ON ts.oid=c.reltablespace
    WHERE ${userNamespace} AND c.relkind IN ('r','p','v','m','c','S')`,
  columns: `SELECT n.nspname, c.relname, a.attnum, a.attname,
    format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull, a.attidentity,
    a.attgenerated, a.attstorage, a.attcompression, a.attstattarget,
    cn.nspname AS collation_schema, co.collname AS collation,
    pg_get_expr(d.adbin,d.adrelid,false) AS default_expression,
    ${canonicalAcl('a.attacl')} AS acl,
    ARRAY(SELECT x FROM unnest(a.attoptions) x ORDER BY x) AS options
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
    WHERE ${userNamespace} AND c.relkind IN ('r','p','v','m','c') AND a.attnum>0 AND NOT a.attisdropped`,
  constraints: `SELECT n.nspname, co.conname, c.relname, format_type(co.contypid,NULL) AS domain_type,
    co.contype, co.condeferrable, co.condeferred, co.convalidated, co.conislocal, co.coninhcount,
    co.connoinherit, pg_get_constraintdef(co.oid,false) AS definition
    FROM pg_constraint co JOIN pg_namespace n ON n.oid=co.connamespace
    LEFT JOIN pg_class c ON c.oid=co.conrelid WHERE ${userNamespace}`,
  indexes: `SELECT n.nspname, c.relname, pg_get_indexdef(c.oid,0,false) AS definition,
    i.indisvalid, i.indisready, i.indisreplident, i.indisclustered, i.indnullsnotdistinct,
    ARRAY(SELECT x FROM unnest(c.reloptions) x ORDER BY x) AS options
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${userNamespace}`,
  inheritance: `SELECT childns.nspname AS child_schema, child.relname AS child,
    parentns.nspname AS parent_schema, parent.relname AS parent, i.inhseqno
    FROM pg_inherits i JOIN pg_class child ON child.oid=i.inhrelid
    JOIN pg_namespace childns ON childns.oid=child.relnamespace
    JOIN pg_class parent ON parent.oid=i.inhparent JOIN pg_namespace parentns ON parentns.oid=parent.relnamespace
    WHERE childns.nspname !~ '^pg_' AND childns.nspname <> 'information_schema'`,
  functions: `SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_get_functiondef(p.oid) AS definition, pg_get_userbyid(p.proowner) AS owner,
    ${canonicalAcl('p.proacl')} AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${userNamespace}`,
  triggers: `SELECT n.nspname, c.relname, t.tgname, t.tgenabled,
    pg_get_triggerdef(t.oid,false) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${userNamespace} AND NOT t.tgisinternal`,
  // Native constraint trigger names contain allocation OIDs. Their function,
  // constraint and relation identities describe each role without those names.
  internal_triggers: `SELECT n.nspname,c.relname,t.tgenabled,t.tgtype,t.tgdeferrable,t.tginitdeferred,
    pn.nspname AS function_schema,p.proname AS function_name,pg_get_function_identity_arguments(p.oid) AS function_arguments,
    cn.nspname AS constraint_schema,co.conname AS constraint_name,
    tn.nspname AS constraint_table_schema,tc.relname AS constraint_table,
    rn.nspname AS referenced_schema,rc.relname AS referenced_table,ic.relname AS constraint_index,
    t.tgattr::text AS columns,t.tgnargs,encode(t.tgargs,'hex') AS arguments,
    pg_get_expr(t.tgqual,t.tgrelid,false) AS condition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
    LEFT JOIN pg_constraint co ON co.oid=t.tgconstraint LEFT JOIN pg_namespace cn ON cn.oid=co.connamespace
    LEFT JOIN pg_class tc ON tc.oid=co.conrelid LEFT JOIN pg_namespace tn ON tn.oid=tc.relnamespace
    LEFT JOIN pg_class rc ON rc.oid=t.tgconstrrelid LEFT JOIN pg_namespace rn ON rn.oid=rc.relnamespace
    LEFT JOIN pg_class ic ON ic.oid=t.tgconstrindid WHERE ${userNamespace} AND t.tgisinternal`,
  policies: `SELECT n.nspname,c.relname,p.polname,p.polcmd,p.polpermissive,
    ARRAY(SELECT CASE WHEN role=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role) END FROM unnest(p.polroles) role ORDER BY 1) AS roles,
    pg_get_expr(p.polqual,p.polrelid,false) AS using_expression,
    pg_get_expr(p.polwithcheck,p.polrelid,false) AS check_expression
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${userNamespace}`,
  types: `SELECT n.nspname,t.typname,t.typtype,t.typnotnull,
    format_type(t.typbasetype,t.typtypmod) AS base_type, pg_get_userbyid(t.typowner) AS owner,
    pg_get_expr(t.typdefaultbin,0,false) AS default_expression,
    ${canonicalAcl('t.typacl')} AS acl,
    cn.nspname AS collation_schema,co.collname AS collation,
    ARRAY(SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid=t.oid ORDER BY e.enumsortorder) AS enum_labels
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    LEFT JOIN pg_collation co ON co.oid=t.typcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
    WHERE ${userNamespace} AND t.typtype IN ('d','e','c')`,
  collations: `SELECT n.nspname,c.collname,pg_get_userbyid(c.collowner) AS owner,c.collprovider,c.collisdeterministic,c.collencoding,
    c.collcollate,c.collctype,c.colliculocale,c.collversion,pg_collation_actual_version(c.oid) AS actual_version
    FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace
    WHERE (${userNamespace}) OR c.oid IN (
      SELECT a.attcollation FROM pg_attribute a JOIN pg_class r ON r.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=r.relnamespace WHERE ${userNamespace}
      UNION SELECT t.typcollation FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${userNamespace})`,
  languages: `SELECT l.lanname,pg_get_userbyid(l.lanowner) AS owner,l.lanispl,l.lanpltrusted,
    l.lanplcallfoid::regprocedure::text AS handler,l.laninline::regprocedure::text AS inline_handler,
    l.lanvalidator::regprocedure::text AS validator,${canonicalAcl('l.lanacl')} AS acl
    FROM pg_language l WHERE l.lanname IN ('sql','plpgsql')`,
  defaults: `SELECT pg_get_userbyid(d.defaclrole) AS role,n.nspname,d.defaclobjtype,
    ${canonicalAcl('d.defaclacl')} AS acl
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace`,
};
const unsupportedQueries: [string, string][] = [
  ['temporary fixture objects', "SELECT 1 FROM pg_class WHERE relpersistence='t'"],
  ['extended statistics objects', `SELECT 1 FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid=s.stxnamespace WHERE ${userNamespace}`],
  ['security labels', 'SELECT 1 FROM pg_seclabel'],
  ['foreign data wrappers or servers', 'SELECT 1 FROM pg_foreign_data_wrapper UNION ALL SELECT 1 FROM pg_foreign_server'],
  ['custom encoding conversions', `SELECT 1 FROM pg_conversion c JOIN pg_namespace n ON n.oid=c.connamespace WHERE ${userNamespace}`],
  ['extensions other than plpgsql', "SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql'"],
  ['foreign or temporary relations, unpopulated materialized views, or non-heap tables', `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_am am ON am.oid=c.relam WHERE (${userNamespace}) AND (c.relkind='f' OR c.relpersistence='t' OR (c.relkind='m' AND NOT c.relispopulated) OR (c.relkind='r' AND am.amname<>'heap'))`],
  ['custom range or base types', `SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE ${userNamespace} AND t.typtype NOT IN ('c','d','e') AND NOT (t.typelem<>0 AND t.typlen=-1)`],
  ['custom aggregates or procedural languages other than SQL and PL/pgSQL', `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE ${userNamespace} AND (p.prokind NOT IN ('f','p') OR l.lanname NOT IN ('sql','plpgsql'))`],
  ['custom rewrite rules', `SELECT 1 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${userNamespace} AND r.rulename<>'_RETURN'`],
  ['event triggers', 'SELECT 1 FROM pg_event_trigger'],
  ['large objects', 'SELECT 1 FROM pg_largeobject_metadata'],
  ['logical replication configuration', 'SELECT 1 FROM pg_publication UNION ALL SELECT 1 FROM pg_subscription'],
  ['custom casts', 'SELECT 1 FROM pg_cast WHERE oid>=16384'],
  ['custom operators', `SELECT 1 FROM pg_operator o JOIN pg_namespace n ON n.oid=o.oprnamespace WHERE ${userNamespace}`],
  ['custom operator classes/families', `SELECT 1 FROM pg_opclass o JOIN pg_namespace n ON n.oid=o.opcnamespace WHERE ${userNamespace} UNION ALL SELECT 1 FROM pg_opfamily o JOIN pg_namespace n ON n.oid=o.opfnamespace WHERE ${userNamespace}`],
  ['custom text search objects', `SELECT 1 FROM pg_ts_config c JOIN pg_namespace n ON n.oid=c.cfgnamespace WHERE ${userNamespace} UNION ALL SELECT 1 FROM pg_ts_dict d JOIN pg_namespace n ON n.oid=d.dictnamespace WHERE ${userNamespace} UNION ALL SELECT 1 FROM pg_ts_parser p JOIN pg_namespace n ON n.oid=p.prsnamespace WHERE ${userNamespace} UNION ALL SELECT 1 FROM pg_ts_template t JOIN pg_namespace n ON n.oid=t.tmplnamespace WHERE ${userNamespace}`],
];

// This PG16-native profile treats reserved schemas as native catalog input. A
// normal user-created object has an OID at or above FirstNormalObjectId. Reject
// additions instead of silently treating them as unchanged server state.
const reservedNamespace = `(n.nspname OPERATOR(pg_catalog.~) '^pg_' OR n.nspname OPERATOR(pg_catalog.=) 'information_schema')`;
const userCreatedReservedObjects = `
  SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_class o JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.relnamespace
    WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace} AND NOT (
      n.nspname OPERATOR(pg_catalog.=) 'pg_toast' AND (
        (o.relkind OPERATOR(pg_catalog.=) 't' AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_class owner JOIN pg_catalog.pg_namespace owner_n ON owner_n.oid OPERATOR(pg_catalog.=) owner.relnamespace
          WHERE owner.reltoastrelid OPERATOR(pg_catalog.=) o.oid
            AND owner_n.nspname OPERATOR(pg_catalog.!~) '^pg_'
            AND owner_n.nspname OPERATOR(pg_catalog.<>) 'information_schema'))
        OR (o.relkind OPERATOR(pg_catalog.=) 'i' AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_index toast_index
          JOIN pg_catalog.pg_class toast ON toast.oid OPERATOR(pg_catalog.=) toast_index.indrelid
          JOIN pg_catalog.pg_class owner ON owner.reltoastrelid OPERATOR(pg_catalog.=) toast.oid
          JOIN pg_catalog.pg_namespace owner_n ON owner_n.oid OPERATOR(pg_catalog.=) owner.relnamespace
          WHERE toast_index.indexrelid OPERATOR(pg_catalog.=) o.oid
            AND toast.relkind OPERATOR(pg_catalog.=) 't'
            AND owner_n.nspname OPERATOR(pg_catalog.!~) '^pg_'
            AND owner_n.nspname OPERATOR(pg_catalog.<>) 'information_schema'))
      ))
  UNION ALL SELECT 1 FROM pg_catalog.pg_proc o JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.pronamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_type o JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.typnamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_constraint o JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.connamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_collation o JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.collnamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_conversion o JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.connamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.oprnamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_opclass o JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.opcnamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_opfamily o JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.opfnamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_statistic_ext o JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.stxnamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_ts_config o JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.cfgnamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_ts_dict o JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.dictnamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_ts_parser o JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.prsnamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_ts_template o JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.tmplnamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_rewrite o JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) o.ev_class JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_trigger o JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) o.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_policy o JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) o.polrelid JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}
  UNION ALL SELECT 1 FROM pg_catalog.pg_attrdef o JOIN pg_catalog.pg_class c ON c.oid OPERATOR(pg_catalog.=) o.adrelid JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace WHERE o.oid OPERATOR(pg_catalog.>=) 16384 AND ${reservedNamespace}`;

/**
 * Fingerprint committed fixture state before actors start. Caller must keep the owned
 * database quiescent throughout: sequences are not MVCC snapshots. This opens and closes
 * its own read-only connection and never changes the setup client's transaction/settings.
 * This is fixture provenance, not application-source or server-binary attestation.
 */
export async function captureFixtureIdentity(connectionString: string, options: FixtureIdentityOptions = {}): Promise<FixtureIdentity> {
  const maxObjects = limit(options.maxObjects, 10_000, 100_000, 'maxObjects');
  const maxRows = limit(options.maxRows, 100_000, 1_000_000, 'maxRows');
  const maxBytes = limit(options.maxBytes, 64 * 1024 * 1024, 1024 * 1024 * 1024, 'maxBytes');
  const timeoutMs = limit(options.timeoutMs, 10_000, 120_000, 'timeoutMs');
  const started = performance.now();
  const counts = { objects: 0, rows: 0, bytes: 0 };
  const client = new Client({ connectionString, connectionTimeoutMillis: timeoutMs });
  client.on('error', () => {});
  let interrupted: FixtureIdentityError | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopReject: ((error: FixtureIdentityError) => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => { stopReject = reject; });
  const interrupt = (code: 'aborted' | 'budget-exceeded') => {
    interrupted ??= new FixtureIdentityError(code, code === 'aborted' ? 'Fixture identity capture was cancelled' : 'Fixture identity deadline exceeded');
    stopReject!(interrupted); void client.end().catch(() => {});
  };
  const abort = () => interrupt('aborted');
  function check(): void {
    if (interrupted) throw interrupted;
    if (performance.now() - started >= timeoutMs) throw new FixtureIdentityError('budget-exceeded', 'Fixture identity deadline exceeded');
  }
  function account(bytes: string | number, objects = 0, rows = 0): void {
    counts.bytes += Number(bytes); counts.objects += objects; counts.rows += rows;
    if (!Number.isSafeInteger(counts.bytes) || counts.bytes > maxBytes || counts.objects > maxObjects || counts.rows > maxRows) {
      throw new FixtureIdentityError('budget-exceeded', 'Fixture identity object, row, or canonical-byte budget exceeded');
    }
  }
  function digest(value: string): string {
    account(Buffer.byteLength(value));
    return hash(value);
  }
  const combine = (values: string[]): string => digest(JSON.stringify([...values].sort()));
  async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    check(); const result = await client.query<T>(text, values); check(); return result.rows;
  }
  async function quiescent(): Promise<void> {
    // An uncommitted setup session must fail before we wait on one of its table locks.
    const activity = await query<{ busy: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datname OPERATOR(pg_catalog.=) pg_catalog.current_database()
      AND pid OPERATOR(pg_catalog.<>) pg_catalog.pg_backend_pid()
      AND backend_type OPERATOR(pg_catalog.=) 'client backend'
      AND (state IS NULL OR state OPERATOR(pg_catalog.<>) 'idle' OR xact_start IS NOT NULL)) AS busy`);
    if (activity[0]!.busy) throw new FixtureIdentityError('not-quiescent', 'Fixture identity requires committed setup and no active actor or external transactions');
  }
  async function records(label: string, sql: string, values: unknown[] = []): Promise<string> {
    const rows = await query<{ digest: string; bytes: string }>(`SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload,'UTF8')),'hex') AS digest,
      pg_catalog.octet_length(payload)::pg_catalog.text AS bytes FROM (SELECT pg_catalog.to_jsonb(q)::pg_catalog.text AS payload FROM (${sql}) q LIMIT ${maxObjects - counts.objects + 1}) canonical`, values);
    for (const row of rows) account(row.bytes, 1);
    return digest(JSON.stringify([label, rows.map(row => row.digest).sort()]));
  }
  const run = async (): Promise<FixtureIdentity> => {
    check(); await client.connect(); check();
    const version = await query<{ version: string }>("SELECT pg_catalog.current_setting('server_version_num') AS version");
    if (!version[0]!.version.startsWith('16')) throw new FixtureIdentityError('unsupported', 'Fixture identity profile is qualified for PostgreSQL 16 only');
    await quiescent();
    // Even casting a builtin jsonb catalog record to text can invoke a custom
    // cast. Reject before the first serialization, while observing original GUCs.
    if ((await query('SELECT 1 FROM pg_catalog.pg_cast WHERE oid OPERATOR(pg_catalog.>=) 16384 LIMIT 1')).length) {
      throw new FixtureIdentityError('unsupported', 'Fixture identity does not yet cover custom casts');
    }
    if ((await query(`SELECT 1 FROM (${userCreatedReservedObjects}) reserved_object LIMIT 1`)).length) {
      throw new FixtureIdentityError('unsupported', 'Fixture identity does not cover user-created objects in reserved PostgreSQL schemas');
    }
    const settings = [await records('effective-settings', 'SELECT name,setting,unit FROM pg_catalog.pg_settings')];
    // Original actor-equivalent defaults above are evidence; normalize only this capture connection.
    await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await query("SELECT set_config('statement_timeout',$1,true), set_config('lock_timeout',$1,true)", [String(Math.max(1, Math.floor(timeoutMs - (performance.now() - started))))]);
    await query("SET LOCAL search_path=pg_catalog; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD'; SET LOCAL intervalstyle='postgres'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'; SET LOCAL lc_monetary='C'; SET LOCAL row_security=off");
    // pg_settings omits custom placeholders. Read the resolved pg 8.23 startup
    // options (including PGOPTIONS), and the defaults applied to the login role.
    const startupOptions = (client as unknown as { connectionParameters: { options?: string } }).connectionParameters.options ?? '';
    settings.push(await records('effective-custom-settings', `WITH names(name) AS (
      SELECT unnest($1::text[])
      UNION SELECT translate(split_part(setting,'=',1),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')
        FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) setting
        WHERE s.setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
          AND s.setrole IN (0,(SELECT oid FROM pg_roles WHERE rolname=session_user))
    ) SELECT name,current_setting(name,true) AS setting FROM names WHERE strpos(name,'.')>0`, [startupSettingNames(startupOptions)]));
    settings.push(await records('database-settings', `SELECT pg_encoding_to_char(d.encoding) AS encoding,d.datlocprovider,d.datcollate,d.datctype,d.daticulocale,d.datcollversion,
      pg_database_collation_actual_version(d.oid) AS actual_collation_version,
      pg_get_userbyid(d.datdba) AS owner,
      ${canonicalAcl('d.datacl')} AS acl
      FROM pg_database d WHERE d.datname=current_database()`));
    settings.push(await records('session-role', `SELECT current_user AS current_role,session_user AS session_role,
      r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolbypassrls,
      ARRAY(SELECT x FROM unnest(r.rolconfig) x ORDER BY x) AS role_config
      FROM pg_roles r WHERE r.rolname=current_user`));
    settings.push(await records('relevant-role-attributes', `${relevantRoles}
      SELECT r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,
      r.rolreplication,r.rolbypassrls,r.rolconnlimit,r.rolvaliduntil::text,
      ARRAY(SELECT x FROM unnest(r.rolconfig) x ORDER BY x) AS role_config
      FROM pg_roles r JOIN relevant p ON p.id=r.oid`));
    settings.push(await records('relevant-role-memberships', `${relevantRoles}
      SELECT pg_get_userbyid(m.roleid) AS role,pg_get_userbyid(m.member) AS member,
      pg_get_userbyid(m.grantor) AS grantor,m.admin_option,m.inherit_option,m.set_option
      FROM pg_auth_members m JOIN relevant p ON p.id=m.member`));
    for (const [feature, sql] of unsupportedQueries) {
      if ((await query(`SELECT 1 FROM (${sql}) unsupported LIMIT 1`)).length) throw new FixtureIdentityError('unsupported', `Fixture identity does not yet cover ${feature}`);
    }
    const schema: string[] = [];
    for (const [label, sql] of Object.entries(schemaQueries)) schema.push(await records(label, sql));
    interface Relation extends QueryResultRow { schema: string; name: string; kind: string; columns: string[] }
    const relations = await query<Relation>(`SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,
      ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum) AS columns
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE ${userNamespace} AND c.relkind IN ('r','m','S') ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C" LIMIT ${maxObjects + 1}`);
    if (relations.length > maxObjects) throw new FixtureIdentityError('budget-exceeded', 'Fixture relation budget exceeded');
    const data: string[] = []; const sequences: string[] = [];
    const sequenceState = new Map<string, string>();
    sequences.push(await records('sequence-definitions', `SELECT n.nspname,c.relname,format_type(s.seqtypid,NULL) AS type,
      s.seqstart::text,s.seqincrement::text,s.seqmax::text,s.seqmin::text,s.seqcache::text,s.seqcycle,
      pn.nspname AS owned_schema,p.relname AS owned_table,a.attname AS owned_column,d.deptype
      FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_class'::regclass AND d.refobjsubid>0 AND d.deptype IN ('a','i')
      LEFT JOIN pg_class p ON p.oid=d.refobjid LEFT JOIN pg_namespace pn ON pn.oid=p.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid=p.oid AND a.attnum=d.refobjsubid WHERE ${userNamespace}`));
    for (const relation of relations) {
      const qualified = `${escapeIdentifier(relation.schema)}.${escapeIdentifier(relation.name)}`;
      if (relation.kind === 'S') {
        const state = JSON.stringify(await query(`SELECT last_value::text,is_called FROM ${qualified}`));
        sequenceState.set(qualified, state);
        sequences.push(digest(JSON.stringify([relation.schema,relation.name,state]))); continue;
      }
      // Text output retains exact numeric precision, JSON text, bytea and array bounds;
      // JSON encodes per-column null/string boundaries without calling user functions.
      const columns = relation.columns.map(name => `t.${escapeIdentifier(name)}::text`).join(',');
      await query(`DECLARE interleave_fixture_rows NO SCROLL CURSOR FOR
        SELECT encode(sha256(convert_to(payload,'UTF8')),'hex') AS digest,octet_length(payload)::text AS bytes
        FROM (SELECT to_jsonb(ARRAY[${columns}]::text[])::text AS payload FROM ONLY ${qualified} t LIMIT ${maxRows - counts.rows + 1}) encoded`);
      const digests: string[] = [];
      while (true) {
        const batch = await query<{ digest: string; bytes: string }>('FETCH FORWARD 128 FROM interleave_fixture_rows');
        for (const row of batch) { account(row.bytes, 0, 1); digests.push(row.digest); }
        if (batch.length < 128) break;
      }
      await query('CLOSE interleave_fixture_rows');
      data.push(digest(JSON.stringify([relation.schema,relation.name,digests.sort()])));
    }
    // Sequence values do not follow the repeatable-read snapshot. Recheck and fail if observed changing.
    for (const [qualified, previous] of sequenceState) {
      if (JSON.stringify(await query(`SELECT last_value::text,is_called FROM ${qualified}`)) !== previous) throw new FixtureIdentityError('not-quiescent', 'Sequence changed during fixture identity capture');
    }
    await query('COMMIT'); await quiescent();
    const components = { schema: combine(schema), data: combine(data), sequences: combine(sequences), settings: combine(settings) };
    const fingerprint = digest(JSON.stringify(['postgresql16-native-v1',components]));
    return { version: 1, profile: 'postgresql16-native-v1', algorithm: 'sha256', fingerprint, components, counts };
  };
  try {
    timer = setTimeout(() => interrupt('budget-exceeded'), timeoutMs); timer.unref();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) interrupt('aborted');
    return await Promise.race([stopped, run()]);
  } catch (error) {
    if (interrupted) throw interrupted;
    if (error instanceof FixtureIdentityError) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === '57014' || code === '55P03') throw new FixtureIdentityError('budget-exceeded', 'Fixture identity query or lock deadline exceeded');
    throw new FixtureIdentityError('database-error', `Fixture identity database operation failed${/^[0-9A-Z]{5}$/.test(code) ? ` (SQLSTATE ${code})` : ''}`);
  } finally {
    if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
    await client.end().catch(() => {});
  }
}
