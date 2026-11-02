import { useMemo } from "react";
import { ArrowLeftRight } from "lucide-react";
import { Button } from "../../components/ui";
import {
  base64ToBytes, bytesToBase64, CodeArea, CopyButton, decodeUtf8, encodeUtf8, Message, Pane,
  Segmented, toBase64Url, Toggle, useToolState,
} from "./shared";

type Mode = "encode" | "decode";

export default function Base64Tool() {
  const [mode, setMode] = useToolState<Mode>("b64.mode", "encode");
  const [input, setInput] = useToolState("b64.input", "");
  const [urlSafe, setUrlSafe] = useToolState("b64.urlsafe", false);

  const result = useMemo((): { out: string; error?: string } => {
    if (!input) return { out: "" };
    try {
      if (mode === "encode") {
        const b64 = bytesToBase64(encodeUtf8(input));
        return { out: urlSafe ? toBase64Url(b64) : b64 };
      }
      return { out: decodeUtf8(base64ToBytes(input)) };
    } catch (e) {
      const msg = e instanceof TypeError
        ? "Decoded bytes are not valid UTF-8 text (it may be binary data)"
        : "Not valid base64";
      return { out: "", error: msg };
    }
  }, [input, mode, urlSafe]);

  function swap() {
    if (result.error) return;
    setMode(mode === "encode" ? "decode" : "encode");
    setInput(result.out);
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-3">
        <Segmented value={mode} onChange={setMode}
          options={[{ value: "encode", label: "Encode" }, { value: "decode", label: "Decode" }]} />
        {mode === "encode" && <Toggle label="URL-safe (base64url, no padding)" checked={urlSafe} onChange={setUrlSafe} />}
        {mode === "decode" && <span className="text-xs text-muted">Accepts standard and URL-safe input</span>}
        <div className="flex-1" />
        <Button onClick={swap} disabled={!result.out}><ArrowLeftRight size={14} /> Use output as input</Button>
      </div>
      {result.error && <Message kind="error">{result.error}</Message>}
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-4">
        <Pane label={mode === "encode" ? "Text" : "Base64"}>
          <CodeArea value={input} onChange={(e) => setInput(e.target.value)}
            placeholder={mode === "encode" ? "Text to encode" : "Base64 to decode"} />
        </Pane>
        <Pane label={mode === "encode" ? "Base64" : "Text"} actions={<CopyButton value={result.out} />}>
          <CodeArea readOnly value={result.out} />
        </Pane>
      </div>
    </div>
  );
}
