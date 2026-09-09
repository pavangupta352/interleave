export const PGVECTOR_FIXTURE_PROFILE = 'postgresql17-pgvector0.8.6-v1' as const;
export const PGVECTOR_EXTENSION_VERSION = '0.8.6';
export const PGVECTOR_MEMBER_COUNT = 237;
export const PGVECTOR_MEMBER_INVENTORY_SHA256 = '8a1a5d2cf68ced2cba18a87495fbac0faeb923469e55127f6961037d5ab0b3d7';

const extensionMember = (catalog: string, oid: string): string => `EXISTS (
  SELECT 1 FROM pg_catalog.pg_depend interleave_vector_member
  JOIN pg_catalog.pg_extension interleave_vector_extension
    ON interleave_vector_extension.oid OPERATOR(pg_catalog.=) interleave_vector_member.refobjid
  WHERE interleave_vector_member.refclassid OPERATOR(pg_catalog.=) 'pg_catalog.pg_extension'::pg_catalog.regclass
    AND interleave_vector_member.deptype OPERATOR(pg_catalog.=) 'e'
    AND interleave_vector_extension.extname OPERATOR(pg_catalog.=) 'vector'
    AND interleave_vector_member.classid OPERATOR(pg_catalog.=) 'pg_catalog.${catalog}'::pg_catalog.regclass
    AND interleave_vector_member.objid OPERATOR(pg_catalog.=) ${oid}
    AND interleave_vector_member.objsubid OPERATOR(pg_catalog.=) 0
)`;

export const pgvectorMembership = {
  accessMethod: extensionMember('pg_am', 'am.oid'),
  cast: extensionMember('pg_cast', 'c.oid'),
  operatorClass: extensionMember('pg_opclass', 'o.oid'),
  operator: extensionMember('pg_operator', 'o.oid'),
  operatorFamily: extensionMember('pg_opfamily', 'o.oid'),
  procedure: extensionMember('pg_proc', 'p.oid'),
  type: extensionMember('pg_type', 't.oid'),
} as const;

export const pgvectorExtensionSql = `SELECT e.extname,e.extversion,n.nspname AS schema,e.extrelocatable,
  CASE WHEN e.extconfig IS NULL THEN NULL ELSE ARRAY(
    SELECT pg_catalog.pg_describe_object('pg_catalog.pg_class'::pg_catalog.regclass,config_oid,0)
    FROM pg_catalog.unnest(e.extconfig) config_oid ORDER BY 1) END AS configuration,
  CASE WHEN e.extcondition IS NULL THEN NULL ELSE ARRAY(SELECT condition FROM pg_catalog.unnest(e.extcondition) condition ORDER BY 1) END AS conditions,
  CASE WHEN e.extowner OPERATOR(pg_catalog.=) (SELECT oid FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) CURRENT_USER)
    THEN '$current_user' ELSE pg_catalog.pg_get_userbyid(e.extowner) END AS owner
  FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) e.extnamespace
  WHERE e.extname OPERATOR(pg_catalog.=) 'vector'`;

export const pgvectorMemberInventorySql = `SELECT CASE d.classid
    WHEN 'pg_catalog.pg_am'::pg_catalog.regclass THEN 'pg_am'
    WHEN 'pg_catalog.pg_cast'::pg_catalog.regclass THEN 'pg_cast'
    WHEN 'pg_catalog.pg_opclass'::pg_catalog.regclass THEN 'pg_opclass'
    WHEN 'pg_catalog.pg_operator'::pg_catalog.regclass THEN 'pg_operator'
    WHEN 'pg_catalog.pg_opfamily'::pg_catalog.regclass THEN 'pg_opfamily'
    WHEN 'pg_catalog.pg_proc'::pg_catalog.regclass THEN 'pg_proc'
    WHEN 'pg_catalog.pg_type'::pg_catalog.regclass THEN 'pg_type'
    ELSE 'unsupported'
  END AS class_name,identity.type AS object_type,identity.object_names,identity.object_args
  FROM pg_catalog.pg_depend d
  JOIN pg_catalog.pg_extension e ON e.oid OPERATOR(pg_catalog.=) d.refobjid
  CROSS JOIN LATERAL pg_catalog.pg_identify_object_as_address(d.classid,d.objid,d.objsubid) identity
  WHERE d.refclassid OPERATOR(pg_catalog.=) 'pg_catalog.pg_extension'::pg_catalog.regclass
    AND d.deptype OPERATOR(pg_catalog.=) 'e' AND e.extname OPERATOR(pg_catalog.=) 'vector'`;

const normalizedOwner = (oid: string): string => `CASE WHEN ${oid} OPERATOR(pg_catalog.=)
  (SELECT oid FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) CURRENT_USER)
  THEN '$current_user' ELSE pg_catalog.pg_get_userbyid(${oid}) END`;
const normalizedAcl = (acl: string): string => `CASE WHEN ${acl} IS NULL THEN NULL ELSE ARRAY(
  SELECT privilege FROM (SELECT pg_catalog.jsonb_build_array(
    CASE WHEN x.grantor OPERATOR(pg_catalog.=) (SELECT oid FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) CURRENT_USER)
      THEN '$current_user' ELSE pg_catalog.pg_get_userbyid(x.grantor) END,
    CASE WHEN x.grantee OPERATOR(pg_catalog.=) 0 THEN 'PUBLIC'
      WHEN x.grantee OPERATOR(pg_catalog.=) (SELECT oid FROM pg_catalog.pg_roles WHERE rolname OPERATOR(pg_catalog.=) CURRENT_USER)
      THEN '$current_user' ELSE pg_catalog.pg_get_userbyid(x.grantee) END,
    x.privilege_type,x.is_grantable)::pg_catalog.text AS privilege
  FROM pg_catalog.aclexplode(${acl}) x) privileges ORDER BY privilege COLLATE "C") END`;

export const pgvectorContractQueries: Record<string, string> = {
  extension: pgvectorExtensionSql,
  types: `SELECT pg_catalog.format_type(t.oid,NULL) AS identity,t.typtype,t.typlen,t.typbyval,t.typalign,t.typstorage,
    t.typcategory,t.typispreferred,t.typdelim,t.typnotnull,t.typisdefined,t.typndims,
    pg_catalog.format_type(t.typbasetype,t.typtypmod) AS base_type,t.typdefault,t.typdefaultbin,
    pg_catalog.format_type(t.typelem,NULL) AS element_type,pg_catalog.format_type(t.typarray,NULL) AS array_type,
    t.typinput::pg_catalog.regprocedure::pg_catalog.text AS input,t.typoutput::pg_catalog.regprocedure::pg_catalog.text AS output,
    t.typreceive::pg_catalog.regprocedure::pg_catalog.text AS receive,t.typsend::pg_catalog.regprocedure::pg_catalog.text AS send,
    t.typmodin::pg_catalog.regprocedure::pg_catalog.text AS modifier_input,t.typmodout::pg_catalog.regprocedure::pg_catalog.text AS modifier_output,
    t.typanalyze::pg_catalog.regprocedure::pg_catalog.text AS analyze,t.typsubscript::pg_catalog.regprocedure::pg_catalog.text AS subscript,
    ${normalizedOwner('t.typowner')} AS owner,${normalizedAcl('t.typacl')} AS acl
    FROM pg_catalog.pg_type t WHERE ${pgvectorMembership.type}`,
  procedures: `SELECT n.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_catalog.pg_get_function_result(p.oid) AS result,
    CASE WHEN p.prokind OPERATOR(pg_catalog.<>) 'a' THEN pg_catalog.pg_get_functiondef(p.oid) END AS definition,
    p.prokind,p.prosecdef,p.proleakproof,p.proisstrict,
    p.provolatile,p.proparallel,p.procost::pg_catalog.text,p.prorows::pg_catalog.text,
    p.prosupport::pg_catalog.regprocedure::pg_catalog.text AS support,
    ARRAY(SELECT setting FROM pg_catalog.unnest(p.proconfig) setting ORDER BY setting COLLATE "C") AS configuration,
    p.probin,p.prosrc,
    a.aggkind,a.aggnumdirectargs,a.aggtransfn::pg_catalog.regprocedure::pg_catalog.text AS aggregate_transition,
    a.aggfinalfn::pg_catalog.regprocedure::pg_catalog.text AS aggregate_final,
    a.aggcombinefn::pg_catalog.regprocedure::pg_catalog.text AS aggregate_combine,
    a.aggserialfn::pg_catalog.regprocedure::pg_catalog.text AS aggregate_serialize,
    a.aggdeserialfn::pg_catalog.regprocedure::pg_catalog.text AS aggregate_deserialize,
    a.aggmtransfn::pg_catalog.regprocedure::pg_catalog.text AS aggregate_moving_transition,
    a.aggminvtransfn::pg_catalog.regprocedure::pg_catalog.text AS aggregate_moving_inverse,
    a.aggmfinalfn::pg_catalog.regprocedure::pg_catalog.text AS aggregate_moving_final,
    a.aggfinalextra,a.aggmfinalextra,a.aggfinalmodify,a.aggmfinalmodify,
    a.aggsortop::pg_catalog.regoperator::pg_catalog.text AS aggregate_sort_operator,
    pg_catalog.format_type(a.aggtranstype,NULL) AS aggregate_transition_type,a.aggtransspace,
    pg_catalog.format_type(a.aggmtranstype,NULL) AS aggregate_moving_transition_type,a.aggmtransspace,
    a.agginitval,a.aggminitval,
    ${normalizedOwner('p.proowner')} AS owner,${normalizedAcl('p.proacl')} AS acl
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) p.pronamespace
    LEFT JOIN pg_catalog.pg_aggregate a ON a.aggfnoid OPERATOR(pg_catalog.=) p.oid
    WHERE ${pgvectorMembership.procedure}`,
  casts: `SELECT pg_catalog.format_type(c.castsource,NULL) AS source_type,pg_catalog.format_type(c.casttarget,NULL) AS target_type,
    c.castfunc::pg_catalog.regprocedure::pg_catalog.text AS function,c.castcontext,c.castmethod
    FROM pg_catalog.pg_cast c WHERE ${pgvectorMembership.cast}`,
  operators: `SELECT n.nspname,o.oprname,pg_catalog.format_type(o.oprleft,NULL) AS left_type,
    pg_catalog.format_type(o.oprright,NULL) AS right_type,pg_catalog.format_type(o.oprresult,NULL) AS result_type,
    o.oprcode::pg_catalog.regprocedure::pg_catalog.text AS function,
    o.oprcom::pg_catalog.regoperator::pg_catalog.text AS commutator,o.oprnegate::pg_catalog.regoperator::pg_catalog.text AS negator,
    o.oprrest::pg_catalog.regprocedure::pg_catalog.text AS restrict_selectivity,
    o.oprjoin::pg_catalog.regprocedure::pg_catalog.text AS join_selectivity,o.oprcanhash,o.oprcanmerge
    FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.oprnamespace
    WHERE ${pgvectorMembership.operator}`,
  access_methods: `SELECT am.amname,am.amtype,am.amhandler::pg_catalog.regprocedure::pg_catalog.text AS handler
    FROM pg_catalog.pg_am am WHERE ${pgvectorMembership.accessMethod}`,
  operator_families: `SELECT am.amname,n.nspname,o.opfname,${normalizedOwner('o.opfowner')} AS owner
    FROM pg_catalog.pg_opfamily o JOIN pg_catalog.pg_am am ON am.oid OPERATOR(pg_catalog.=) o.opfmethod
    JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.opfnamespace
    WHERE ${pgvectorMembership.operatorFamily}`,
  operator_classes: `SELECT am.amname,n.nspname,o.opcname,o.opcdefault,
    pg_catalog.format_type(o.opcintype,NULL) AS input_type,pg_catalog.format_type(o.opckeytype,NULL) AS key_type,
    family.opfname AS family,${normalizedOwner('o.opcowner')} AS owner
    FROM pg_catalog.pg_opclass o JOIN pg_catalog.pg_am am ON am.oid OPERATOR(pg_catalog.=) o.opcmethod
    JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) o.opcnamespace
    JOIN pg_catalog.pg_opfamily family ON family.oid OPERATOR(pg_catalog.=) o.opcfamily
    WHERE ${pgvectorMembership.operatorClass}`,
  family_operators: `SELECT am.amname,n.nspname,f.opfname,o.amopstrategy,o.amoppurpose,
    pg_catalog.format_type(o.amoplefttype,NULL) AS left_type,pg_catalog.format_type(o.amoprighttype,NULL) AS right_type,
    o.amopopr::pg_catalog.regoperator::pg_catalog.text AS operator,
    CASE WHEN o.amopsortfamily OPERATOR(pg_catalog.=) 0 THEN NULL ELSE sort_family.opfname END AS sort_family
    FROM pg_catalog.pg_amop o JOIN pg_catalog.pg_opfamily f ON f.oid OPERATOR(pg_catalog.=) o.amopfamily
    JOIN pg_catalog.pg_am am ON am.oid OPERATOR(pg_catalog.=) f.opfmethod
    JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) f.opfnamespace
    LEFT JOIN pg_catalog.pg_opfamily sort_family ON sort_family.oid OPERATOR(pg_catalog.=) o.amopsortfamily
    WHERE ${extensionMember('pg_opfamily', 'f.oid')}`,
  family_procedures: `SELECT am.amname,n.nspname,f.opfname,p.amprocnum,
    pg_catalog.format_type(p.amproclefttype,NULL) AS left_type,pg_catalog.format_type(p.amprocrighttype,NULL) AS right_type,
    p.amproc::pg_catalog.regprocedure::pg_catalog.text AS function
    FROM pg_catalog.pg_amproc p JOIN pg_catalog.pg_opfamily f ON f.oid OPERATOR(pg_catalog.=) p.amprocfamily
    JOIN pg_catalog.pg_am am ON am.oid OPERATOR(pg_catalog.=) f.opfmethod
    JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) f.opfnamespace
    WHERE ${extensionMember('pg_opfamily', 'f.oid')}`,
};

// Filled from the pristine catalog in pgvector/pgvector:0.8.6-pg17-bookworm.
// Each value is the fixture recorder's label-and-row-digest aggregate.
export const pgvectorContractDigests: Record<keyof typeof pgvectorContractQueries, string> = {
  extension: '92142323fa31cf21e71fdfc457e0073a4ff4572db105d9686d1b4cd0e49212c4',
  types: 'b25b86f83279196285d03abec5a36889246d4ae392a31ef8870cdb2be096bb78',
  procedures: '0c031f8ada6e897deaf87d0c7573188ad63afdbd9f6942c60bd757e133ade208',
  casts: '2422beb79ce7f9bcd1b8ab010fa66ff54232cb887c873594f0adabc0b69dffd7',
  operators: '73887f8d3445faa9bc35dde02964d2fd699a243c9b3c808202f8822cb04dbeb2',
  access_methods: 'bc833f71f2b1b1985d993c3c513e846f50158a79179545023f8cecaa52641735',
  operator_families: 'dd73b4f954babb86a123030735b431d71b75896b20d7212c6e59b2d1615f7638',
  operator_classes: '92b9a620669d75a5e5849e51cbd5bd3759609729ee927b917bbeed8f82499b73',
  family_operators: '545b55292d04ea904d1052263717d8c766c480fdf4efb8118c1e734015f6817b',
  family_procedures: '7caa9c9838a94a79765999af0efec1d3a9b709c9e30e3c0409c6ccea59206e35',
};

export const pgvectorSettingNames = [
  'hnsw.ef_search',
  'hnsw.iterative_scan',
  'hnsw.max_scan_tuples',
  'hnsw.scan_mem_multiplier',
  'ivfflat.iterative_scan',
  'ivfflat.max_probes',
  'ivfflat.probes',
] as const;

export const pgvectorSettingContractSql = `SELECT name,unit,vartype,min_val,max_val,enumvals,context,boot_val
  FROM pg_catalog.pg_settings WHERE name OPERATOR(pg_catalog.=) ANY(ARRAY[
    'hnsw.ef_search','hnsw.iterative_scan','hnsw.max_scan_tuples','hnsw.scan_mem_multiplier',
    'ivfflat.iterative_scan','ivfflat.max_probes','ivfflat.probes']::pg_catalog.text[])`;

export const PGVECTOR_SETTING_CONTRACT_SHA256 = 'ffaea8bcca9af77157c56c371c72d33590523ee8f15d9be51781c0f66621f209';
