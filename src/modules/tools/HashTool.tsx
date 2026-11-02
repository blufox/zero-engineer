import { useMemo } from "react";
import { hmac } from "@noble/hashes/hmac.js";
import { md5, sha1 } from "@noble/hashes/legacy.js";
import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Input } from "../../components/ui";
import { bytesToBase64, CodeArea, encodeUtf8, OutputList, OutputRow, Pane, Segmented, Toggle, useToolState } from "./shared";

const ALGOS = [
  { name: "MD5", fn: md5, note: "not secure: checksums only" },
  { name: "SHA-1", fn: sha1, note: "not secure: legacy" },
  { name: "SHA-256", fn: sha256 },
  { name: "SHA-384", fn: sha384 },
  { name: "SHA-512", fn: sha512 },
] as const;

type Encoding = "hex" | "base64";

export default function HashTool() {
  const [input, setInput] = useToolState("hash.input", "");
  const [useHmac, setUseHmac] = useToolState("hash.hmac", false);
  const [key, setKey] = useToolState("hash.key", "");
  const [encoding, setEncoding] = useToolState<Encoding>("hash.enc", "hex");
  const [upper, setUpper] = useToolState("hash.upper", false);

  const hashes = useMemo(() => {
    const data = encodeUtf8(input);
    const k = encodeUtf8(key);
    return ALGOS.map(({ name, fn }) => {
      const bytes = useHmac ? hmac(fn, k, data) : fn(data);
      let out = encoding === "hex" ? bytesToHex(bytes) : bytesToBase64(bytes);
      if (upper && encoding === "hex") out = out.toUpperCase();
      return { name, out };
    });
  }, [input, key, useHmac, encoding, upper]);

  return (
    <div className="flex flex-col gap-4">
      <Pane label="Input text" className="h-40">
        <CodeArea value={input} onChange={(e) => setInput(e.target.value)} placeholder="Text to hash (UTF-8)" />
      </Pane>

      <div className="flex flex-wrap items-center gap-4">
        <Segmented value={encoding} onChange={setEncoding}
          options={[{ value: "hex", label: "Hex" }, { value: "base64", label: "Base64" }]} />
        {encoding === "hex" && <Toggle label="Uppercase" checked={upper} onChange={setUpper} />}
        <Toggle label="HMAC" checked={useHmac} onChange={setUseHmac} />
        {useHmac && (
          <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="HMAC secret key"
            className="max-w-xs font-mono text-xs" />
        )}
      </div>

      <OutputList>
        {hashes.map((h) => (
          <OutputRow key={h.name} label={(useHmac ? "HMAC-" : "") + h.name} value={h.out} />
        ))}
      </OutputList>
      <p className="text-xs text-muted">
        {ALGOS.filter((a) => "note" in a).map((a) => `${a.name}: ${"note" in a ? a.note : ""}`).join(" · ")}.
        For passwords use bcrypt or argon2, not a plain hash.
      </p>
    </div>
  );
}
