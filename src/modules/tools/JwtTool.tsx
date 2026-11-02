import { useMemo } from "react";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import { Input } from "../../components/ui";
import {
  base64ToBytes, bytesToBase64, CodeArea, CopyButton, decodeUtf8, encodeUtf8, Message, Pane,
  toBase64Url, useToolState,
} from "./shared";
import { formatLocal, relative } from "./time";

type Json = Record<string, unknown>;

interface Decoded {
  header: Json;
  payload: Json;
  signingInput: string;
  signature: string;
}

function decodeJwt(token: string): Decoded {
  const parts = token.trim().split(".");
  if (parts.length !== 3) throw new Error(`A JWT has 3 dot-separated parts; this has ${parts.length}`);
  const part = (s: string, name: string) => {
    try {
      return JSON.parse(decodeUtf8(base64ToBytes(s))) as Json;
    } catch {
      throw new Error(`The ${name} is not valid base64url-encoded JSON`);
    }
  };
  return {
    header: part(parts[0], "header"),
    payload: part(parts[1], "payload"),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: parts[2],
  };
}

const HMACS = { HS256: sha256, HS384: sha384, HS512: sha512 } as const;

function verifyHmac(d: Decoded, secret: string): boolean | "unsupported" {
  const hash = HMACS[d.header.alg as keyof typeof HMACS];
  if (!hash) return "unsupported";
  const sig = hmac(hash, encodeUtf8(secret), encodeUtf8(d.signingInput));
  return toBase64Url(bytesToBase64(sig)) === d.signature;
}

const TIME_CLAIMS: Record<string, string> = { exp: "Expires", iat: "Issued at", nbf: "Not before" };

const CLAIM_NAMES: Record<string, string> = {
  iss: "Issuer", sub: "Subject", aud: "Audience", jti: "JWT ID", ...TIME_CLAIMS,
};

export default function JwtTool() {
  const [token, setToken] = useToolState("jwt.token", "");
  const [secret, setSecret] = useToolState("jwt.secret", "");

  const result = useMemo(() => {
    if (!token.trim()) return null;
    try {
      return { decoded: decodeJwt(token) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [token]);

  const decoded = result?.decoded;
  const verification = decoded && secret ? verifyHmac(decoded, secret) : null;
  const exp = typeof decoded?.payload.exp === "number" ? new Date(decoded.payload.exp * 1000) : null;

  return (
    <div className="flex h-full flex-col gap-3">
      <Pane label="Encoded token" className="h-32 shrink-0">
        <CodeArea value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJhbGciOi..." className="break-all" />
      </Pane>

      {result?.error && <Message kind="error">{result.error}</Message>}

      {decoded && (
        <div className="flex flex-wrap items-center gap-2">
          {exp && (exp.getTime() < Date.now()
            ? <Message kind="error">Expired {relative(exp)}</Message>
            : <Message kind="ok">Valid until {formatLocal(exp)} ({relative(exp)})</Message>)}
          {!exp && <Message kind="info">No exp claim, so this token never expires</Message>}
          <Message kind="info">Algorithm: <span className="font-mono">{String(decoded.header.alg)}</span></Message>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
        <div className="flex min-h-0 flex-col gap-3">
          <Pane label="Header" actions={<CopyButton value={decoded ? JSON.stringify(decoded.header, null, 2) : ""} />}>
            <pre className="selectable overflow-auto rounded-md border border-line bg-surface p-3 font-mono text-xs">
              {decoded ? JSON.stringify(decoded.header, null, 2) : " "}
            </pre>
          </Pane>
          <Pane label="Payload" className="min-h-0 flex-1"
            actions={<CopyButton value={decoded ? JSON.stringify(decoded.payload, null, 2) : ""} />}>
            <pre className="selectable flex-1 overflow-auto rounded-md border border-line bg-surface p-3 font-mono text-xs">
              {decoded ? JSON.stringify(decoded.payload, null, 2) : " "}
            </pre>
          </Pane>
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-auto">
          <Pane label="Claims">
            <div className="rounded-md border border-line bg-surface">
              {decoded && Object.entries(decoded.payload).map(([k, v]) => (
                <div key={k} className="flex gap-3 border-b border-line px-3 py-1.5 text-xs last:border-b-0">
                  <span className="w-24 shrink-0 font-mono text-accent">{k}</span>
                  <span className="selectable flex-1 break-all font-mono">
                    {typeof v === "string" ? v : JSON.stringify(v)}
                    {k in TIME_CLAIMS && typeof v === "number" && (
                      <span className="mt-0.5 block font-sans text-muted">
                        {formatLocal(new Date(v * 1000))} · {relative(new Date(v * 1000))}
                      </span>
                    )}
                  </span>
                  <span className="text-muted">{CLAIM_NAMES[k] ?? ""}</span>
                </div>
              ))}
              {!decoded && <div className="px-3 py-2 text-xs text-muted">Paste a token to see its claims</div>}
            </div>
          </Pane>

          <Pane label="Verify signature (HMAC)">
            <Input value={secret} onChange={(e) => setSecret(e.target.value)}
              placeholder="Shared secret (HS256 / HS384 / HS512)" className="font-mono text-xs" />
            <div className="mt-2">
              {verification === true && <Message kind="ok">Signature verified</Message>}
              {verification === false && <Message kind="error">Invalid signature for this secret</Message>}
              {verification === "unsupported" && (
                <Message kind="info">
                  Only HMAC (HS*) tokens can be verified here. {String(decoded?.header.alg)} needs a public key.
                </Message>
              )}
              {verification === null && (
                <p className="text-xs text-muted">Decoding never needs the secret. The secret stays in memory and is never saved.</p>
              )}
            </div>
          </Pane>
        </div>
      </div>
    </div>
  );
}
