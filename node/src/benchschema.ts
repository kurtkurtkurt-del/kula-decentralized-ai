// A small json-schema checker for tools/bench-schema.json: just the keywords that schema
// uses (type, const, enum, required, properties, additionalProperties, items, minItems,
// minimum, minLength, pattern, oneOf, $ref into #/definitions). No dependency, so the
// phone and the computer can both check a result before writing or reading it. Kept the
// same in node/src/benchschema.ts and app/src/llm/benchschema.ts.
export type Schema = Record<string, any>;

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function hasType(v: unknown, t: string): boolean {
  if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeOf(v) === t;
}

function resolve(root: Schema, s: Schema): Schema {
  if (typeof s.$ref !== 'string') return s;
  const m = /^#\/definitions\/([^/]+)$/.exec(s.$ref);
  if (!m || !root.definitions?.[m[1]]) throw new Error(`bad $ref ${s.$ref}`);
  return root.definitions[m[1]];
}

/** Every way `value` breaks `schema`, as "path: why" lines; empty when it conforms. */
export function validate(schema: Schema, value: unknown, path = '$', root: Schema = schema): string[] {
  const s = resolve(root, schema);
  const out: string[] = [];
  const bad = (why: string) => out.push(`${path}: ${why}`);
  if ('const' in s && value !== s.const) bad(`must be ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.includes(value)) bad(`must be one of ${s.enum.map((x: unknown) => JSON.stringify(x)).join(', ')}`);
  if (s.type !== undefined) {
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => hasType(value, t))) { bad(`must be ${types.join(' or ')}, got ${typeOf(value)}`); return out; }
  }
  if (Array.isArray(s.oneOf)) {
    const hits = s.oneOf.filter((alt: Schema) => validate(alt, value, path, root).length === 0).length;
    if (hits !== 1) bad(`must match exactly one alternative (matched ${hits})`);
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) bad(`must be ≥ ${s.minimum}`);
  }
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) bad(`must be at least ${s.minLength} chars`);
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(value)) bad(`must match ${s.pattern}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) bad(`needs at least ${s.minItems} items`);
    if (s.items) value.forEach((v, i) => out.push(...validate(s.items, v, `${path}[${i}]`, root)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in obj)) bad(`missing ${k}`);
    const props: Record<string, Schema> = s.properties ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) out.push(...validate(props[k], v, `${path}.${k}`, root));
      else if (s.additionalProperties === false) bad(`unknown field ${k}`);
    }
  }
  return out;
}

/** Throws with every problem listed when the value does not conform. */
export function assertValid(schema: Schema, value: unknown, what = 'bench result'): void {
  const problems = validate(schema, value);
  if (problems.length) throw new Error(`${what} does not match ${schema.$id ?? 'the schema'}:\n  ${problems.join('\n  ')}`);
}
