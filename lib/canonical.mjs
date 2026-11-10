import { createHash } from "node:crypto";
export * from "./envelope.mjs";
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
