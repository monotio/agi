/**
 * Validates tool arguments against the JSON Schema subset used by the tool
 * catalog. Anthropic tools are sent non-strict (see toolTransport.ts), so this
 * is the authoritative check before any handler mutates session state. The
 * supported keywords are exactly those the catalog uses: type (including
 * union arrays), properties, required, additionalProperties, items, enum,
 * minimum, maximum, minItems, maxItems, minLength, maxLength.
 */
export function validateToolArguments(schema: unknown, value: unknown): string[] {
  const errors: string[] = [];
  check(schema, value, "", errors);
  return errors;
}

function nullable(schema: unknown): boolean {
  const type =
    schema && typeof schema === "object" ? (schema as Record<string, unknown>)["type"] : undefined;
  return Array.isArray(type) && type.includes("null");
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function check(schema: unknown, value: unknown, path: string, errors: string[]): void {
  if (!schema || typeof schema !== "object") return;
  const s = schema as Record<string, unknown>;
  const label = path || "arguments";
  const allowed = s["type"] === undefined ? [] : Array.isArray(s["type"]) ? s["type"] : [s["type"]];
  const actual = typeOf(value);
  if (allowed.length) {
    const ok = allowed.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!ok) {
      errors.push(`${label} must be ${allowed.join(" or ")}, got ${actual}.`);
      return;
    }
  }
  if (Array.isArray(s["enum"]) && !s["enum"].some((e) => e === value))
    errors.push(`${label} must be one of ${JSON.stringify(s["enum"])}.`);
  if (typeof value === "number") {
    if (typeof s["minimum"] === "number" && value < s["minimum"])
      errors.push(`${label} must be >= ${s["minimum"]}, got ${value}.`);
    if (typeof s["maximum"] === "number" && value > s["maximum"])
      errors.push(`${label} must be <= ${s["maximum"]}, got ${value}.`);
  }
  if (typeof value === "string") {
    if (typeof s["minLength"] === "number" && value.length < s["minLength"])
      errors.push(`${label} must have at least ${s["minLength"]} characters.`);
    if (typeof s["maxLength"] === "number" && value.length > s["maxLength"])
      errors.push(`${label} must have at most ${s["maxLength"]} characters.`);
  }
  if (Array.isArray(value)) {
    if (typeof s["minItems"] === "number" && value.length < s["minItems"])
      errors.push(`${label} must have at least ${s["minItems"]} items.`);
    if (typeof s["maxItems"] === "number" && value.length > s["maxItems"])
      errors.push(`${label} must have at most ${s["maxItems"]} items.`);
    if (s["items"]) value.forEach((item, i) => check(s["items"], item, `${label}[${i}]`, errors));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (s["properties"] ?? {}) as Record<string, unknown>;
    // The catalog lists every property as required and marks optional ones
    // nullable (strict-mode convention). A missing nullable field reads as
    // null, so only non-nullable omissions are errors.
    for (const key of Array.isArray(s["required"]) ? s["required"] : [])
      if (!(key in obj) && !nullable(props[key])) errors.push(`${label}.${key} is required.`);
    for (const [key, item] of Object.entries(obj)) {
      const child = path ? `${path}.${key}` : key;
      if (key in props) check(props[key], item, child, errors);
      else if (s["additionalProperties"] === false) errors.push(`${child} is not a known field.`);
    }
  }
}
