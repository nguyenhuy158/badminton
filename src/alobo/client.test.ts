import { describe, expect, it } from "vitest";
import { decodeResponse, deriveKeys, sign } from "./client";

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(bytes: Uint8Array | ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function bundleFixture(
  prefix = "renamed",
  response = "r".repeat(32),
  base = "https://user-global.alobo.vn",
) {
  const parts: string[] = [];
  const symbols: string[] = [];
  [base, response, "test-signature"].forEach((text, index) => {
    const value = [...encoder.encode(text)];
    const symbol = `${prefix}${index}`;
    symbols.push(`$.${symbol}()`);
    parts.push(
      `s($,"unused${index}","${symbol}",()=>{var q,p=t.S,o=J.changed(${value.length},p)\nfor(q=0;q<${value.length};++q)o[q]=q\nreturn A.text(B.b.map(o,new A.${symbol}Class(),p),0,null)})`,
      `A.${symbol}Class.prototype={\n$1(a){return(B.${symbol}Left[a]^B.${symbol}Right[a])>>>0},\n$S:6}`,
      `B.${symbol}Left=s(${JSON.stringify(value.map((byte) => byte ^ 7))},t.S)`,
      `B.${symbol}Right=s(${JSON.stringify(value.map(() => 7))},t.S)`,
    );
  });
  parts.push(
    `new A.${prefix}Config(${symbols.join(",")})`,
    `${prefix}Config:function ${prefix}Config(a,b,c){var _=this\n_.url=a\n_.key=b\n_.sign=c}`,
    `A.${prefix}Config.prototype={\n${prefix}Response(){return this.key},\n${prefix}Sign(){return this.sign}}`,
    `if(J.G(a.a,"iv")!=null){l=$.settings().${prefix}Response()\nn=readIv()}`,
    `headers.l(0,"x-user-app",A.${prefix}Signer())`,
    `${prefix}Signer(){return hash(format("MM/dd/yyyy, HH:mm")+"@"+$.settings().${prefix}Sign())}`,
  );
  return parts.join("\n");
}

describe("deriveKeys", () => {
  it.each(["oldBuild", "nextBuild"])(
    "follows renamed symbols and ignores other environments (%s)",
    async (prefix) => {
      const dev = bundleFixture("dev", "r".repeat(32), "https://dev.alobo.vn")
        .replace('headers.l(0,"x-user-app",A.devSigner())', "")
        .replace(
          'if(J.G(a.a,"iv")!=null){l=$.settings().devResponse()\nn=readIv()}',
          "",
        );
      const keys = deriveKeys(`${dev}\n${bundleFixture(prefix)}`);
      expect(new TextDecoder().decode(keys.responseKey)).toBe("r".repeat(32));
      const stamp = await sign(
        new Date("2026-11-03T07:00:00Z"),
        keys.signatureKey,
      );
      const expected = toHex(
        await crypto.subtle.digest(
          "SHA-256",
          encoder.encode("11/03/2026, 07:00@test-signature"),
        ),
      );
      expect(stamp).toBe(expected);
    },
  );

  it.each([
    ["empty", ""],
    [
      "only another environment",
      bundleFixture("renamed", "r".repeat(32), "https://dev.alobo.vn"),
    ],
    ["ambiguous", bundleFixture().repeat(2)],
  ])("fails closed on a missing or ambiguous config (%s)", (_name, bundle) => {
    expect(() => deriveKeys(bundle)).toThrow();
  });

  it("fails closed on a wrong response key length", () => {
    expect(() => deriveKeys(bundleFixture("renamed", "short"))).toThrow(
      "response key length",
    );
  });

  it("fails closed when the key class is missing", () => {
    const bundle = bundleFixture().replace(
      "A.renamed1Class.prototype=",
      "A.missing.prototype=",
    );
    expect(() => deriveKeys(bundle)).toThrow("key class");
  });

  it("fails closed on a wrong array length", () => {
    const bundle = bundleFixture().replace(
      "J.changed(32,p)",
      "J.changed(31,p)",
    );
    expect(() => deriveKeys(bundle)).toThrow("key length");
  });
});

describe("decodeResponse", () => {
  const key = new Uint8Array(32).fill(7);

  async function encrypt(value: unknown, iv = new Uint8Array(16).fill(3)) {
    const imported = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "AES-CBC" },
      false,
      ["encrypt"],
    );
    const data = await crypto.subtle.encrypt(
      { name: "AES-CBC", iv },
      imported,
      encoder.encode(JSON.stringify(value)),
    );
    return JSON.stringify({
      enc: true,
      iv: toBase64(iv),
      data: toBase64(data),
    });
  }

  it("decrypts what AES-256-CBC with PKCS7 produced", async () => {
    expect(
      await decodeResponse(await encrypt([{ branchId: "a" }]), key),
    ).toEqual([{ branchId: "a" }]);
  });

  it("fails closed when the response is not encrypted", async () => {
    await expect(
      decodeResponse(JSON.stringify({ enc: false, data: [] }), key),
    ).rejects.toThrow("encryption state");
  });

  it("fails closed on a wrong IV or block length", async () => {
    const good = JSON.parse(await encrypt({ a: 1 }));
    await expect(
      decodeResponse(JSON.stringify({ ...good, iv: "AAAA" }), key),
    ).rejects.toThrow("invalid length");
    await expect(
      decodeResponse(JSON.stringify({ ...good, data: "AAAA" }), key),
    ).rejects.toThrow("invalid length");
  });

  it("fails closed on a wrong key", async () => {
    await expect(
      decodeResponse(await encrypt({ a: 1 }), new Uint8Array(32).fill(9)),
    ).rejects.toThrow();
  });
});
