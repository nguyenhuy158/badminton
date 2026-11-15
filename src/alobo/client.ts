export type Keys = { responseKey: Uint8Array; signatureKey: string };

const EXPECTED_BASE = "https://user-global.alobo.vn";
const RESPONSE_KEY_BYTES = 32;
const IV_BYTES = 16;
const AES_BLOCK_BYTES = 16;
const KEY_EXCERPT_CHARS = 220;
const KEY_CLASS_EXCERPT_CHARS = 160;
const BYTE_MASK = 255;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function arrayOf(bundle: string, name: string): number[] {
  const match = new RegExp(
    `B\\.${escapeRegExp(name)}=s\\(\\[([^\\]]+)\\]`,
  ).exec(bundle);
  if (!match) throw new Error("Alobo bundle array is missing");
  return match[1].split(",").map((item) => Math.trunc(Number.parseFloat(item)));
}

function obfuscatedKey(bundle: string, symbol: string): Uint8Array {
  const found = bundle.indexOf(`"${symbol}",()=>`);
  if (found < 0) throw new Error("Alobo key function is missing");
  const excerpt = bundle.slice(found, found + KEY_EXCERPT_CHARS);
  const length = /J\.[\w$]+\((\d+),[\w$]+\)/.exec(excerpt);
  const klass = /new A\.([\w$]+)\(/.exec(excerpt);
  if (!klass) throw new Error("Alobo key function changed");
  const marker = `A.${klass[1]}.prototype=`;
  const start = bundle.indexOf(marker);
  if (start < 0) throw new Error("Alobo key class is missing");
  const expression = /B\.([A-Za-z0-9_$]+)\[a\]\^B\.([A-Za-z0-9_$]+)\[a\]/.exec(
    bundle.slice(start, start + KEY_CLASS_EXCERPT_CHARS),
  );
  if (!expression) throw new Error("Alobo key expression changed");
  const left = arrayOf(bundle, expression[1]);
  const right = arrayOf(bundle, expression[2]);
  const expected = length ? Number(length[1]) : Number.NaN;
  if (left.length !== expected || right.length !== expected) {
    throw new Error("Alobo key length changed");
  }
  return Uint8Array.from(
    left,
    (value, index) => (value ^ right[index]) & BYTE_MASK,
  );
}

function uniqueGroups(pattern: RegExp, text: string): string[] {
  const seen = new Map<string, string[]>();
  for (const match of text.matchAll(new RegExp(pattern.source, "g"))) {
    const groups = match.slice(1);
    seen.set(JSON.stringify(groups), groups);
  }
  if (seen.size !== 1)
    throw new Error("Alobo bundle structure is missing or ambiguous");
  return [...seen.values()][0];
}

function productionConfig(bundle: string): Map<string, Uint8Array> {
  const candidates: Map<string, Uint8Array>[] = [];
  const configs = bundle.matchAll(
    /new A\.([\w$]+)\(((?:\$\.[\w$]+\(\),?){2,})\)/g,
  );
  for (const [, name, args] of configs) {
    const symbols = [...args.matchAll(/\$\.([\w$]+)\(\)/g)].map(
      (match) => match[1],
    );
    const values = symbols.map((symbol) => obfuscatedKey(bundle, symbol));
    const base = new TextEncoder().encode(EXPECTED_BASE);
    if (!values.some((value) => bytesEqual(value, base))) continue;
    const [rawParameters, body] = uniqueGroups(
      new RegExp(
        `${escapeRegExp(name)}:function ${escapeRegExp(name)}\\(([^)]*)\\)\\{([^}]+)\\}`,
      ),
      bundle,
    );
    const parameters = rawParameters.split(",");
    if (parameters.length !== values.length)
      throw new Error("Alobo config argument count changed");
    const fields = new Map<string, Uint8Array>();
    const assignments = new Map<string, string>();
    for (const match of body.matchAll(/_\.([\w$]+)=([\w$]+)/g))
      assignments.set(match[1], match[2]);
    for (const [field, argument] of assignments) {
      const index = parameters.indexOf(argument);
      if (index >= 0) fields.set(field, values[index]);
    }
    const start = bundle.indexOf(`A.${name}.prototype=`);
    if (start < 0) throw new Error("Alobo config class is missing");
    const end = bundle.indexOf("\nA.", start + 1);
    const prototype = bundle.slice(start, end >= 0 ? end : undefined);
    const config = new Map<string, Uint8Array>();
    for (const [, getter, field] of prototype.matchAll(
      /([\w$]+)\(\)\{return this\.([\w$]+)\}/g,
    )) {
      const value = fields.get(field);
      if (value) config.set(getter, value);
    }
    candidates.push(config);
  }
  if (candidates.length !== 1)
    throw new Error("Alobo production config is missing or ambiguous");
  return candidates[0];
}

function configKey(
  config: Map<string, Uint8Array>,
  getter: string,
): Uint8Array {
  const value = config.get(getter);
  if (!value) throw new Error("Alobo config getter is missing");
  return value;
}

export function deriveKeys(bundle: string): Keys {
  const config = productionConfig(bundle);
  const [responseGetter] = uniqueGroups(
    /"iv"\)!=null\)\{[\w$]+=\$\.[\w$]+\(\)\.([\w$]+)\(\)/,
    bundle,
  );
  const responseKey = configKey(config, responseGetter);
  if (responseKey.length !== RESPONSE_KEY_BYTES) {
    throw new Error("Alobo response key length changed");
  }
  const [signer] = uniqueGroups(/"x-user-app",A\.([\w$]+)\(\)/, bundle);
  const [signerBody] = uniqueGroups(
    new RegExp(`${escapeRegExp(signer)}\\(\\)\\{([^}]+)\\}`),
    bundle,
  );
  const [signatureGetter] = uniqueGroups(
    /"@"\+\$\.[\w$]+\(\)\.([\w$]+)\(\)/,
    signerBody,
  );
  const signatureKey = new TextDecoder("ascii").decode(
    configKey(config, signatureGetter),
  );
  return { responseKey, signatureKey };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export async function sign(now: Date, signatureKey: string): Promise<string> {
  const stamp = `${pad(now.getUTCMonth() + 1)}/${pad(now.getUTCDate())}/${now.getUTCFullYear()}, ${pad(
    now.getUTCHours(),
  )}:${pad(now.getUTCMinutes())}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${stamp}@${signatureKey}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function fromBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error("Alobo encrypted response is not valid base64");
  }
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

export async function decodeResponse(
  body: string,
  key: Uint8Array,
): Promise<unknown> {
  const payload = JSON.parse(body) as {
    enc?: unknown;
    iv?: string;
    data?: string;
  };
  if (payload.enc !== true)
    throw new Error("Alobo response encryption state changed");
  const iv = fromBase64(payload.iv ?? "");
  const data = fromBase64(payload.data ?? "");
  if (
    iv.length !== IV_BYTES ||
    data.length === 0 ||
    data.length % AES_BLOCK_BYTES
  ) {
    throw new Error("Alobo encrypted response has invalid length");
  }
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-CBC", iv },
    imported,
    data,
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
