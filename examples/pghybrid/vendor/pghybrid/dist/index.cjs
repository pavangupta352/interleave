'use strict';

// src/config.ts
var DEFAULT_RRF_K = 60;
var COSINE = {
  name: "cosine",
  operator: "<=>",
  opsVector: "vector_cosine_ops",
  opsHalfvec: "halfvec_cosine_ops",
  ascending: true
};
var L2 = {
  name: "l2",
  operator: "<->",
  opsVector: "vector_l2_ops",
  opsHalfvec: "halfvec_l2_ops",
  ascending: true
};
var INNER_PRODUCT = {
  name: "inner_product",
  operator: "<#>",
  opsVector: "vector_ip_ops",
  opsHalfvec: "halfvec_ip_ops",
  ascending: true
};
var L1 = {
  name: "l1",
  operator: "<+>",
  opsVector: "vector_l1_ops",
  opsHalfvec: "halfvec_l1_ops",
  ascending: true
};
var METRICS = {
  cosine: COSINE,
  l2: L2,
  euclidean: L2,
  inner_product: INNER_PRODUCT,
  ip: INNER_PRODUCT,
  l1: L1,
  manhattan: L1
};
function opsFor(metric, vectorType) {
  return vectorType === "vector" ? metric.opsVector : metric.opsHalfvec;
}
var DEFAULT_HEADLINE_OPTIONS = "StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MinWords=8, MaxWords=30";
function resolveMetric(metric) {
  if (metric === void 0) {
    return COSINE;
  }
  if (typeof metric === "string") {
    const known = METRICS[metric];
    if (known === void 0) {
      throw new Error(
        `unknown metric ${JSON.stringify(metric)}; expected one of ${Object.keys(METRICS).sort().join(", ")}`
      );
    }
    return known;
  }
  return metric;
}
function resolveWeights(weights) {
  const vector = weights?.vector ?? 1;
  const text = weights?.text ?? 1;
  if (vector < 0 || text < 0) {
    throw new Error("weights must be non-negative");
  }
  if (vector === 0 && text === 0) {
    throw new Error("at least one weight must be greater than zero");
  }
  return { vector, text };
}
function resolveRecency(recency) {
  if (recency === void 0 || recency === null) {
    return null;
  }
  if (!(recency.halfLifeDays > 0)) {
    throw new Error("halfLifeDays must be greater than zero");
  }
  return { column: recency.column, halfLifeDays: recency.halfLifeDays };
}
var RESERVED_OUTPUT_NAMES = [
  "id",
  "score",
  "fused_score",
  "vector_rank",
  "vector_distance",
  "vector_contribution",
  "text_rank",
  "text_score",
  "text_contribution",
  "recency_factor",
  "highlight"
];
function resolveConfig(config) {
  const reserved = RESERVED_OUTPUT_NAMES;
  const clashes = [
    ...new Set(
      [config.textColumn, ...config.extraColumns ?? []].filter(
        (column) => reserved.includes(column)
      )
    )
  ].sort();
  if (clashes.length > 0) {
    throw new Error(
      `${clashes.map((c) => `'${c}'`).join(", ")} cannot be selected through: the generated statement already returns a column of that name, and the duplicate silently replaces the computed value rather than erroring. Reserved: ${RESERVED_OUTPUT_NAMES.join(", ")}. Rename the column, or expose it under another name with a view.`
    );
  }
  const textMatch = config.textMatch ?? "any";
  if (textMatch !== "any" && textMatch !== "all") {
    throw new Error(`textMatch must be 'any' or 'all', got ${JSON.stringify(textMatch)}`);
  }
  const paramStyle = config.paramStyle ?? "numeric";
  if (paramStyle !== "numeric" && paramStyle !== "pyformat") {
    throw new Error(
      `paramStyle must be 'numeric' or 'pyformat', got ${JSON.stringify(paramStyle)}`
    );
  }
  const vectorType = config.vectorType ?? "vector";
  if (vectorType !== "vector" && vectorType !== "halfvec") {
    throw new Error(
      `vectorType must be 'vector' or 'halfvec', got ${JSON.stringify(vectorType)}`
    );
  }
  const k = config.k ?? DEFAULT_RRF_K;
  if (k < 0) {
    throw new Error("k must be non-negative");
  }
  const candidateLimit = config.candidateLimit ?? 50;
  if (candidateLimit < 1) {
    throw new Error("candidateLimit must be >= 1");
  }
  return {
    table: config.table,
    textColumn: config.textColumn,
    vectorColumn: config.vectorColumn,
    idColumn: config.idColumn ?? "id",
    tsvectorColumn: config.tsvectorColumn ?? null,
    language: resolveLanguage(config.language ?? "english"),
    maxQueryTerms: resolvePositiveInt(config.maxQueryTerms ?? 200, "maxQueryTerms"),
    vectorType,
    metric: resolveMetric(config.metric),
    fusion: config.fusion ?? "rrf",
    k,
    weights: resolveWeights(config.weights),
    candidateLimit,
    filterColumns: config.filterColumns ?? [],
    extraColumns: config.extraColumns ?? [],
    recency: resolveRecency(config.recency),
    queryParser: resolveFromSet(
      config.queryParser ?? "websearch_to_tsquery",
      QUERY_PARSERS,
      "queryParser"
    ),
    rankFunction: resolveFromSet(config.rankFunction ?? "ts_rank_cd", RANK_FUNCTIONS, "rankFunction"),
    paramStyle,
    textMatch,
    headlineOptions: config.headlineOptions ?? DEFAULT_HEADLINE_OPTIONS,
    escapeHighlight: config.escapeHighlight ?? true
  };
}
var LANGUAGE_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
var QUERY_PARSERS = ["websearch_to_tsquery", "plainto_tsquery", "phraseto_tsquery"];
var RANK_FUNCTIONS = ["ts_rank_cd", "ts_rank"];
function resolvePositiveInt(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be an integer >= 1, got ${JSON.stringify(value)}`);
  }
  return value;
}
function resolveLanguage(language) {
  if (typeof language !== "string" || !LANGUAGE_RE.test(language)) {
    throw new Error(
      `language must be a Postgres text search configuration name such as "english", "simple" or "pg_catalog.french", got ${JSON.stringify(language)}. It is interpolated into the statement rather than bound, so only identifier-shaped values are accepted.`
    );
  }
  return language;
}
function resolveFromSet(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
  }
  return value;
}
function opsClass(config) {
  const resolved = resolveConfig(config);
  return opsFor(resolved.metric, resolved.vectorType);
}

// src/textquery.ts
var TOKEN_RE = /(-?)"([^"]*)"|(-?)(\S+)/g;
var NOISE = /* @__PURE__ */ new Set(["or", "and"]);
function parseQuery(text) {
  const positive = [];
  const negative = [];
  const seenPositive = /* @__PURE__ */ new Set();
  const seenNegative = /* @__PURE__ */ new Set();
  const pattern = new RegExp(TOKEN_RE.source, "g");
  let match;
  while ((match = pattern.exec(text ?? "")) !== null) {
    const [, quotedNegation, quoted, bareNegation, bare] = match;
    let term;
    let negated;
    if (quoted !== void 0) {
      term = quoted.trim();
      negated = quotedNegation === "-";
    } else {
      term = (bare ?? "").trim();
      negated = bareNegation === "-";
    }
    if (!term) {
      continue;
    }
    if (!negated && NOISE.has(term.toLowerCase())) {
      continue;
    }
    const bucket = negated ? negative : positive;
    const seen = negated ? seenNegative : seenPositive;
    const folded = term.toLowerCase();
    if (!seen.has(folded)) {
      seen.add(folded);
      bucket.push(term);
    }
  }
  return { positive, negative, isEmpty: positive.length === 0 && negative.length === 0 };
}

// src/sql.ts
var IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
var LN2 = "0.6931471805599453";
var IdentifierError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "IdentifierError";
  }
};
function quoteIdent(name) {
  if (typeof name !== "string" || !name) {
    throw new IdentifierError(
      `identifier must be a non-empty string, got ${JSON.stringify(name) ?? String(name)}`
    );
  }
  const parts = name.split(".");
  if (parts.length > 2) {
    throw new IdentifierError(
      `${JSON.stringify(name)} has too many parts; expected 'name' or 'schema.name'`
    );
  }
  return parts.map((part) => {
    if (!IDENT_RE.test(part)) {
      throw new IdentifierError(
        `${JSON.stringify(part)} is not a valid Postgres identifier. Use letters, digits and underscores, starting with a letter or underscore.`
      );
    }
    return `"${part}"`;
  }).join(".");
}
var TOKEN_RE2 = /\x01p(\d+)\x01/g;
function token(index) {
  return `p${index}`;
}
var Params = class {
  slots = [];
  add(value) {
    this.slots.push(value);
    return token(this.slots.length - 1);
  }
  addCast(value, cast) {
    return `${this.add(value)}::${cast}`;
  }
  /** Substitute placeholders and return the statement with its final values. */
  render(sql, paramStyle) {
    if (paramStyle === "numeric") {
      const numbers = /* @__PURE__ */ new Map();
      const values = [];
      const rendered = sql.replace(TOKEN_RE2, (_match, slot) => {
        const index = Number(slot);
        let number = numbers.get(index);
        if (number === void 0) {
          values.push(this.slots[index]);
          number = values.length;
          numbers.set(index, number);
        }
        return `$${number}`;
      });
      return { sql: rendered, params: values };
    }
    if (paramStyle === "pyformat") {
      const values = [];
      const escaped = sql.replace(/%/g, "%%");
      const rendered = escaped.replace(TOKEN_RE2, (_match, slot) => {
        values.push(this.slots[Number(slot)]);
        return "%s";
      });
      return { sql: rendered, params: values };
    }
    throw new Error(
      `unknown paramStyle ${JSON.stringify(paramStyle)}; expected 'numeric' (node-postgres, asyncpg, raw SQL) or 'pyformat' (psycopg)`
    );
  }
};
function distanceExpr(cfg, vecPlaceholder) {
  return `${quoteIdent(cfg.vectorColumn)} ${cfg.metric.operator} ${vecPlaceholder}`;
}
function tsvectorExpr(cfg) {
  if (cfg.tsvectorColumn) {
    return quoteIdent(cfg.tsvectorColumn);
  }
  return `to_tsvector('${cfg.language}', coalesce(${quoteIdent(cfg.textColumn)}, ''))`;
}
function tsqueryExpr(cfg, text, params) {
  const call = (value) => `${cfg.queryParser}('${cfg.language}', ${params.add(value)})`;
  if (cfg.textMatch === "all") {
    return call(text);
  }
  const positive = parseQuery(text).positive.slice(0, cfg.maxQueryTerms);
  let expression = positive.map(call).join(" || ");
  if (positive.length > 1) {
    expression = `(${expression})`;
  }
  return expression;
}
function showQuery(text) {
  return "'" + text.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}
function exclusionSql(cfg, negatives, params) {
  const tsv = tsvectorExpr(cfg);
  let terms = negatives.map((term) => `${cfg.queryParser}('${cfg.language}', ${params.add(term)})`).join(" || ");
  if (negatives.length > 1) {
    terms = `(${terms})`;
  }
  return ` AND NOT coalesce(${tsv} @@ ${terms}, false)`;
}
function filterSql(cfg, filters, params) {
  if (!filters) {
    return "";
  }
  const entries = Object.entries(filters);
  if (entries.length === 0) {
    return "";
  }
  if (cfg.filterColumns.length === 0) {
    throw new Error(
      "filters were passed but Config.filterColumns is empty. List the columns you intend to filter on so they can be validated and indexed."
    );
  }
  const clauses = [];
  for (const [column, value] of entries) {
    if (!cfg.filterColumns.includes(column)) {
      throw new Error(
        `${JSON.stringify(column)} is not in Config.filterColumns (${cfg.filterColumns.join(", ") || "none"}).`
      );
    }
    const col = quoteIdent(column);
    if (value === null || value === void 0) {
      clauses.push(`${col} IS NULL`);
    } else if (Array.isArray(value) || value instanceof Set) {
      const values = [...value];
      if (values.length === 0) {
        clauses.push("FALSE");
      } else {
        clauses.push(`${col} = ANY(${params.add(values)})`);
      }
    } else {
      clauses.push(`${col} = ${params.add(value)}`);
    }
  }
  return " AND " + clauses.join(" AND ");
}
function recencyExpr(recency, params) {
  if (recency === null) {
    return null;
  }
  const col = quoteIdent(recency.column);
  const halfLife = params.add(recency.halfLifeDays);
  return `coalesce(exp(-${LN2} * greatest(extract(epoch from (now() - ${col})), 0) / (${halfLife} * 86400.0)), 1.0)`;
}
function buildSearchSql(config, options) {
  const cfg = resolveConfig(config);
  const embedding = options.embedding ?? null;
  const text = options.text ?? null;
  const limit = options.limit;
  const offset = options.offset ?? 0;
  const nearMiss = options.nearMiss ?? 0;
  const highlight = options.highlight ?? false;
  if (limit < 1) {
    throw new Error("limit must be >= 1");
  }
  if (offset < 0) {
    throw new Error("offset must be >= 0");
  }
  if (nearMiss < 0) {
    throw new Error("nearMiss must be >= 0");
  }
  const fusion = options.fusion || cfg.fusion;
  let candidateLimit = options.candidateLimit || cfg.candidateLimit;
  if (candidateLimit < limit + nearMiss) {
    candidateLimit = limit + nearMiss;
  }
  if (offset + limit + nearMiss > candidateLimit) {
    throw new Error(
      `offset ${offset} with limit ${limit} needs a candidate pool of at least ${offset + limit + nearMiss}, but it is ${candidateLimit}. Ranks are assigned inside the pool, so widening it per page would reorder every page; raise Config.candidateLimit (or the candidateLimit argument) to the deepest page you intend to serve, and keep it the same across pages.`
    );
  }
  const params = new Params();
  const table = quoteIdent(cfg.table);
  const idCol = quoteIdent(cfg.idColumn);
  const parsed = text !== null ? parseQuery(text) : null;
  const excluded = parsed ? parsed.negative.slice(0, cfg.maxQueryTerms) : [];
  const exclusion = excluded.length > 0 ? exclusionSql(cfg, excluded, params) : "";
  const ctes = [];
  const haveVector = embedding !== null;
  const haveText = parsed !== null && parsed.positive.length > 0;
  if (!haveVector && !haveText) {
    if (excluded.length > 0) {
      throw new Error(
        `${showQuery(text)} only excludes terms, so there is nothing to rank. Add a term to search for, or pass an embedding and let the exclusion filter it.`
      );
    }
    if (text !== null) {
      throw new Error(
        `${showQuery(text)} has no searchable terms in it, so there is nothing to rank. Pass an embedding, or a query with a word to search for.`
      );
    }
    throw new Error("at least one of embedding or text must be provided");
  }
  if (haveVector) {
    const vec = params.addCast(formatVector(embedding), cfg.vectorType);
    const distance = distanceExpr(cfg, vec);
    const where = `WHERE ${quoteIdent(cfg.vectorColumn)} IS NOT NULL` + filterSql(cfg, options.filters, params) + // Without this the vector half happily returns the rows the user excluded.
    exclusion;
    ctes.push(
      // The window sits outside the LIMIT on purpose. A rank() in the same SELECT as
      // ORDER BY ... LIMIT has to see every matching row before the limit can apply, so
      // its cost scales with the number of matches rather than with the limit: 1.19ms
      // against 0.85ms on 100k rows, widening as the table grows. The inner ORDER BY
      // carries a tiebreaker, without which the rows chosen at the cut-off are
      // arbitrary, and ties are not rare.
      `vector_candidates AS (
    SELECT id, distance, rank() OVER (ORDER BY distance) AS rank
    FROM (
        SELECT ${idCol} AS id,
               ${distance} AS distance
        FROM ${table}
        ${where}
        ORDER BY distance, id
        LIMIT ${params.add(candidateLimit)}
    ) candidates
)`
    );
  }
  if (haveText && text !== null) {
    const tsquery = tsqueryExpr(cfg, text, params);
    const tsv = tsvectorExpr(cfg);
    const rankExpr = `${cfg.rankFunction}(${tsv}, tsq)`;
    const where = `WHERE ${tsv} @@ tsq` + filterSql(cfg, options.filters, params) + exclusion;
    ctes.push(
      `text_query AS (
    SELECT ${tsquery} AS tsq
),
text_candidates AS (
    SELECT id, score, rank() OVER (ORDER BY score DESC) AS rank
    FROM (
        SELECT ${idCol} AS id,
               ${rankExpr} AS score
        FROM ${table}, text_query
        ${where}
        ORDER BY score DESC, id
        LIMIT ${params.add(candidateLimit)}
    ) candidates
)`
    );
  }
  const [scoredSelect, scoredFrom] = fusionClause(cfg, params, haveVector, haveText, fusion);
  ctes.push(`scored AS (
    SELECT ${scoredSelect}
    FROM ${scoredFrom}
)`);
  ctes.push(
    "fused AS (\n    SELECT id, vector_rank, vector_distance, vector_contribution,\n           text_rank, text_score, text_contribution,\n           vector_contribution + text_contribution AS fused_score\n    FROM scored\n)"
  );
  const decay = recencyExpr(cfg.recency, params);
  const scoreExpr = decay === null ? "f.fused_score" : `(f.fused_score * ${decay})`;
  const outColumns = [
    "f.id",
    `${scoreExpr} AS score`,
    "f.fused_score AS fused_score",
    "f.vector_rank",
    "f.vector_distance",
    "f.vector_contribution",
    "f.text_rank",
    "f.text_score",
    "f.text_contribution"
  ];
  if (decay !== null) {
    outColumns.push(`${decay} AS recency_factor`);
  }
  for (const column of outputColumns(cfg)) {
    outColumns.push(`t.${quoteIdent(column)}`);
  }
  if (highlight && haveText) {
    const headlineOpts = params.add(cfg.headlineOptions);
    let document = `t.${quoteIdent(cfg.textColumn)}`;
    if (cfg.escapeHighlight) {
      for (const [character, entity] of [
        ["&", "&amp;"],
        ["<", "&lt;"],
        [">", "&gt;"]
      ]) {
        document = `replace(${document}, ${params.add(character)}, ${params.add(entity)})`;
      }
    }
    outColumns.push(
      `ts_headline('${cfg.language}', ${document}, (SELECT tsq FROM text_query), ${headlineOpts}) AS highlight`
    );
  }
  const sql = "WITH " + ctes.join(",\n") + "\nSELECT " + outColumns.join(",\n       ") + `
FROM fused f
JOIN ${table} t ON t.${idCol} = f.id
ORDER BY score DESC, f.id
LIMIT ${params.add(limit + nearMiss)} OFFSET ${params.add(offset)}`;
  return params.render(sql, cfg.paramStyle);
}
function fusionClause(cfg, params, haveVector, haveText, fusion) {
  const vectorWeight = `${params.add(cfg.weights.vector)}::float8`;
  const textWeight = `${params.add(cfg.weights.text)}::float8`;
  let vectorContribution;
  let textContribution;
  if (fusion === "rrf") {
    const k = `${params.add(cfg.k)}::float8`;
    vectorContribution = `${vectorWeight} / (${k} + v.rank)`;
    textContribution = `${textWeight} / (${k} + t.rank)`;
  } else if (fusion === "weighted") {
    vectorContribution = `${vectorWeight} * (1.0 - v.distance)`;
    textContribution = `${textWeight} * t.score`;
  } else {
    throw new Error(
      `unknown fusion method ${JSON.stringify(fusion)}; expected 'rrf' or 'weighted'`
    );
  }
  if (haveVector && haveText) {
    return [
      `coalesce(v.id, t.id) AS id,
           v.rank AS vector_rank,
           v.distance AS vector_distance,
           coalesce(${vectorContribution}, 0) AS vector_contribution,
           t.rank AS text_rank,
           t.score AS text_score,
           coalesce(${textContribution}, 0) AS text_contribution`,
      "vector_candidates v\n    FULL OUTER JOIN text_candidates t ON v.id = t.id"
    ];
  }
  if (haveVector) {
    return [
      `v.id AS id,
           v.rank AS vector_rank,
           v.distance AS vector_distance,
           ${vectorContribution} AS vector_contribution,
           NULL::bigint AS text_rank,
           NULL::double precision AS text_score,
           0.0::float8 AS text_contribution`,
      "vector_candidates v"
    ];
  }
  return [
    `t.id AS id,
           NULL::bigint AS vector_rank,
           NULL::double precision AS vector_distance,
           0.0::float8 AS vector_contribution,
           t.rank AS text_rank,
           t.score AS text_score,
           ${textContribution} AS text_contribution`,
    "text_candidates t"
  ];
}
function outputColumns(cfg) {
  const columns = [];
  const seen = /* @__PURE__ */ new Set();
  for (const column of [cfg.textColumn, ...cfg.extraColumns]) {
    if (column && !seen.has(column)) {
      seen.add(column);
      columns.push(column);
    }
  }
  return columns;
}
function formatFloat(value) {
  if (Number.isNaN(value)) {
    return "nan";
  }
  if (value === Infinity) {
    return "inf";
  }
  if (value === -Infinity) {
    return "-inf";
  }
  const negative = value < 0 || Object.is(value, -0);
  const magnitude = Math.abs(value);
  const [mantissa = "0", exponent = "0"] = magnitude.toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const decpt = Number(exponent) + 1;
  let body;
  if (decpt <= -4 || decpt > 16) {
    const exp = decpt - 1;
    const sign = exp < 0 ? "-" : "+";
    const width = String(Math.abs(exp)).padStart(2, "0");
    const lead = digits.slice(0, 1);
    const rest = digits.slice(1);
    body = `${lead}${rest ? `.${rest}` : ""}e${sign}${width}`;
  } else if (decpt <= 0) {
    body = `0.${"0".repeat(-decpt)}${digits}`;
  } else if (decpt >= digits.length) {
    body = `${digits}${"0".repeat(decpt - digits.length)}.0`;
  } else {
    body = `${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
  }
  return negative ? `-${body}` : body;
}
function formatVector(embedding) {
  if (embedding === null || embedding === void 0) {
    throw new Error("embedding must not be null");
  }
  return `[${Array.from(embedding, (value, index) => {
    const coerced = toNumber(value);
    if (!Number.isFinite(coerced)) {
      throw new Error(`embedding must contain only finite numbers; index ${index} is not finite`);
    }
    return formatFloat(coerced);
  }).join(",")}]`;
}
function toNumber(value) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  throw new Error(
    `embedding must be a sequence of numbers: ${JSON.stringify(value) ?? String(value)}`
  );
}

// src/search.ts
var SIGNAL_COLUMNS = /* @__PURE__ */ new Set([
  "id",
  "score",
  "fused_score",
  "vector_rank",
  "vector_distance",
  "vector_contribution",
  "text_rank",
  "text_score",
  "text_contribution",
  "recency_factor",
  "highlight"
]);
function rowMapping(row) {
  if (row instanceof Map) {
    return Object.fromEntries(row.entries());
  }
  if (typeof row === "object" && row !== null && !Array.isArray(row)) {
    return row;
  }
  throw new TypeError(
    `execute() returned ${row === null ? "null" : typeof row} rows, which are not object-like. Return one object per row with the column names as keys, which node-postgres, postgres.js and Drizzle all do by default.`
  );
}
function asFloat(value) {
  if (value === null || value === void 0) {
    return null;
  }
  if (typeof value === "number") {
    return value;
  }
  const converted = Number(value);
  if (Number.isNaN(converted)) {
    throw new TypeError(
      `expected a number from the database, got ${JSON.stringify(value) ?? String(value)}`
    );
  }
  return converted;
}
function asInt(value) {
  const converted = asFloat(value);
  return converted === null ? null : Math.trunc(converted);
}
function asScore(value) {
  return asFloat(value) ?? 0;
}
function resultFromRow(row) {
  const mapping = rowMapping(row);
  if (!("id" in mapping)) {
    throw new Error(
      "no 'id' column in the result row. This happens when execute() runs a statement pghybrid did not build; pass the sql and params from HybridSearch.buildQuery() through unchanged."
    );
  }
  const vectorRank = asInt(mapping["vector_rank"]);
  const textRank = asInt(mapping["text_rank"]);
  const passthrough = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (!SIGNAL_COLUMNS.has(key)) {
      passthrough[key] = value;
    }
  }
  return {
    id: mapping["id"],
    score: asScore(mapping["score"]),
    fusedScore: asScore(mapping["fused_score"]),
    vectorRank,
    vectorDistance: asFloat(mapping["vector_distance"]),
    vectorContribution: asScore(mapping["vector_contribution"]),
    textRank,
    textScore: asFloat(mapping["text_score"]),
    textContribution: asScore(mapping["text_contribution"]),
    recencyFactor: asFloat(mapping["recency_factor"]),
    highlight: mapping["highlight"] ?? null,
    matchedBy: matchedBy(vectorRank, textRank),
    row: passthrough
  };
}
function matchedBy(vectorRank, textRank) {
  if (vectorRank !== null && textRank !== null) {
    return "both";
  }
  if (vectorRank !== null) {
    return "vector";
  }
  if (textRank !== null) {
    return "text";
  }
  return "none";
}
function resultsFromRows(rows) {
  if (rows === null || rows === void 0) {
    return [];
  }
  return Array.from(rows, resultFromRow);
}
function normaliseText(text) {
  if (text === null || text === void 0) {
    return null;
  }
  return text.trim() ? text : null;
}
var HybridSearch = class {
  config;
  execute;
  constructor(config, execute) {
    if (typeof config !== "object" || config === null) {
      throw new TypeError(`config must be a pghybrid Config object, got ${typeof config}`);
    }
    if (typeof execute !== "function") {
      throw new TypeError(
        "execute must be callable as execute(sql, params). For node-postgres: (sql, params) => pool.query(sql, params).then((r) => r.rows)"
      );
    }
    this.config = config;
    this.execute = execute;
  }
  /**
   * The statement {@link HybridSearch.search} would run, without running it.
   *
   * Worth exposing: the fastest way to debug a ranking is to paste the query into psql
   * and edit it, and the fastest way to trust a library is to read what it sends.
   */
  buildQuery(text, options = {}) {
    return buildSearchSql(this.config, {
      embedding: options.embedding ?? null,
      text: normaliseText(text),
      limit: options.limit ?? 10,
      offset: options.offset ?? 0,
      filters: options.filters ?? null,
      candidateLimit: options.candidateLimit ?? null,
      nearMiss: options.nearMiss ?? 0,
      highlight: options.highlight ?? false,
      fusion: options.fusion ?? null
    });
  }
  /**
   * Rank rows by both signals at once.
   *
   * Passing only `text` runs a pure full-text search and only `embedding` a pure
   * vector search, both returning the same shape, which is what makes comparing the
   * three an apples-to-apples exercise.
   */
  async search(text, options = {}) {
    const { sql, params } = this.buildQuery(text, options);
    return resultsFromRows(await this.execute(sql, params));
  }
};

// src/adapters.ts
function withNumericStyle(config) {
  return { ...config, paramStyle: "numeric" };
}
function asRows(result) {
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray(result.rows)) {
    return result.rows;
  }
  throw new TypeError(
    "the driver returned something that is not a list of rows and has no .rows array; pass your own execute callable instead"
  );
}
function pgExecutor(client) {
  return async (sql, params) => (await client.query(sql, params)).rows;
}
function forPg(client, config) {
  return new HybridSearch(withNumericStyle(config), pgExecutor(client));
}
function postgresJsExecutor(sql) {
  return async (query, params) => asRows(await sql.unsafe(query, params));
}
function forPostgresJs(sql, config) {
  return new HybridSearch(withNumericStyle(config), postgresJsExecutor(sql));
}
function drizzleExecutor(db) {
  const client = db.$client;
  if (!client || typeof client.query !== "function") {
    throw new TypeError(
      "this Drizzle instance exposes no $client to run raw SQL through. Pass the underlying Pool to forPg instead, or supply your own execute callable."
    );
  }
  return pgExecutor(client);
}
function forDrizzle(db, config) {
  return new HybridSearch(withNumericStyle(config), drizzleExecutor(db));
}
function kyselyExecutor(db) {
  return async (sql, params) => {
    const compiled = {
      sql,
      parameters: params,
      query: { kind: "RawNode" },
      queryId: {}
    };
    return (await db.executeQuery(compiled)).rows;
  };
}
function forKysely(db, config) {
  return new HybridSearch(withNumericStyle(config), kyselyExecutor(db));
}

// src/index.ts
var VERSION = "0.1.4";

exports.COSINE = COSINE;
exports.DEFAULT_HEADLINE_OPTIONS = DEFAULT_HEADLINE_OPTIONS;
exports.DEFAULT_RRF_K = DEFAULT_RRF_K;
exports.HybridSearch = HybridSearch;
exports.INNER_PRODUCT = INNER_PRODUCT;
exports.IdentifierError = IdentifierError;
exports.L1 = L1;
exports.L2 = L2;
exports.METRICS = METRICS;
exports.Params = Params;
exports.VERSION = VERSION;
exports.asFloat = asFloat;
exports.buildSearchSql = buildSearchSql;
exports.drizzleExecutor = drizzleExecutor;
exports.forDrizzle = forDrizzle;
exports.forKysely = forKysely;
exports.forPg = forPg;
exports.forPostgresJs = forPostgresJs;
exports.formatVector = formatVector;
exports.kyselyExecutor = kyselyExecutor;
exports.opsClass = opsClass;
exports.opsFor = opsFor;
exports.parseQuery = parseQuery;
exports.pgExecutor = pgExecutor;
exports.postgresJsExecutor = postgresJsExecutor;
exports.quoteIdent = quoteIdent;
exports.resolveConfig = resolveConfig;
exports.resultFromRow = resultFromRow;
exports.resultsFromRows = resultsFromRows;
exports.rowMapping = rowMapping;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map