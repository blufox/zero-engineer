import type { ComponentType } from "react";
import { Binary, Braces, CalendarClock, Clock, Fingerprint, Hash, KeyRound, Regex, type LucideIcon } from "lucide-react";
import JsonTool from "./JsonTool";
import Base64Tool from "./Base64Tool";
import JwtTool from "./JwtTool";
import UuidTool from "./UuidTool";
import TimestampTool from "./TimestampTool";
import RegexTool from "./RegexTool";
import CronTool from "./CronTool";
import HashTool from "./HashTool";

export interface ToolDef {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  component: ComponentType;
  /** Tools whose UI should fill the viewport height (editors side by side). */
  fullHeight?: boolean;
}

/** Add a tool here and it appears in the Dev Tools list. */
export const TOOLS: ToolDef[] = [
  { id: "json", label: "JSON", description: "Format, minify, validate and explore JSON", icon: Braces, component: JsonTool, fullHeight: true },
  { id: "base64", label: "Base64", description: "Encode and decode UTF-8 text", icon: Binary, component: Base64Tool, fullHeight: true },
  { id: "jwt", label: "JWT", description: "Decode tokens, check expiry, verify HMAC signatures", icon: KeyRound, component: JwtTool, fullHeight: true },
  { id: "uuid", label: "UUID", description: "Generate v4/v7 UUIDs and inspect existing ones", icon: Fingerprint, component: UuidTool, fullHeight: true },
  { id: "timestamp", label: "Unix Time", description: "Convert between timestamps and dates", icon: Clock, component: TimestampTool },
  { id: "regex", label: "Regex", description: "Test JavaScript regular expressions live", icon: Regex, component: RegexTool, fullHeight: true },
  { id: "cron", label: "Cron", description: "Explain cron expressions and preview next runs", icon: CalendarClock, component: CronTool },
  { id: "hash", label: "Hash", description: "MD5, SHA-1/256/384/512 and HMAC", icon: Hash, component: HashTool },
];
