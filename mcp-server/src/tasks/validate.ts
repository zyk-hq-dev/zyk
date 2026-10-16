import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

// ajv-formats is CommonJS; its default import is the module object under some resolvers.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as unknown as (ajv: Ajv) => Ajv;

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const cache = new Map<string, ValidateFunction>();
const CACHE_LIMIT = 500;

function compile(schema: object): ValidateFunction {
  const key = JSON.stringify(schema);
  let fn = cache.get(key);
  if (!fn) {
    fn = ajv.compile(schema);
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, fn);
  }
  return fn;
}

/** Throws if `schema` is not a valid JSON Schema. */
export function assertValidSchema(schema: object): void {
  compile(schema);
}

/** Returns human-readable problems; empty when `value` satisfies `schema`. */
export function validateAgainstSchema(schema: object, value: unknown): string[] {
  const validate = compile(schema);
  if (validate(value)) return [];
  return describeAjvErrors(validate.errors ?? []);
}

/** Readable problems for ajv errors; paths are shown relative to `root`. */
export function describeAjvErrors(errors: ErrorObject[], root = "result"): string[] {
  return errors.map((e) => describeError(e, root));
}

/** "/labels/0/name" → "labels[0].name"; empty path → root */
function fieldPathFn(instancePath: string, extra?: string, root = "result"): string {
  const parts = instancePath.split("/").filter(Boolean);
  if (extra) parts.push(extra);
  if (parts.length === 0) return root;
  return parts.reduce(
    (acc, p, i) => (/^\d+$/.test(p) ? `${acc}[${p}]` : i === 0 ? p : `${acc}.${p}`),
    ""
  );
}

function describeError(e: ErrorObject, root: string): string {
  const fieldPath = (path: string, extra?: string) => fieldPathFn(path, extra, root);
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case "required":
      return `field \`${fieldPath(e.instancePath, String(p.missingProperty))}\` is missing`;
    case "additionalProperties":
      return `field \`${fieldPath(e.instancePath, String(p.additionalProperty))}\` is not allowed — remove it`;
    case "type":
      return `field \`${fieldPath(e.instancePath)}\` must be of type ${p.type}`;
    case "enum":
      return `field \`${fieldPath(e.instancePath)}\` must be one of: ${(p.allowedValues as unknown[])
        .map((v) => JSON.stringify(v))
        .join(", ")}`;
    case "const":
      return `field \`${fieldPath(e.instancePath)}\` must be ${JSON.stringify(p.allowedValue)}`;
    case "format":
      return `field \`${fieldPath(e.instancePath)}\` must be a valid ${p.format}`;
    default:
      return `field \`${fieldPath(e.instancePath)}\` ${e.message ?? "is invalid"}`;
  }
}
