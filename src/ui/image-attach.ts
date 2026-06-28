/**
 * image-attach.ts — Phase 2 helper for the `/image` slash command.
 *
 * Reads an image off disk through `WorkspaceGuard`, sniffs the
 * MIME type by looking at the byte prefix (no external lib), caps
 * the byte size at 5 MiB (matches Anthropic's documented ceiling),
 * and returns either a typed `ChatContentBlock` or a structured
 * error. Pure read-side — never writes, never spawns processes.
 */
import fs from "node:fs";
import { WorkspaceGuard } from "../workspace-guard.js";
import type { ChatContentBlock, ChatImageMediaType } from "../shared/types.js";

/** Hard cap before base64 encoding. 5 MiB ≈ 7 MiB once encoded. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type AttachImageResult =
  | {
      ok: true;
      block: ChatContentBlock;
      mediaType: ChatImageMediaType;
      bytes: number;
    }
  | { ok: false; error: string };

/**
 * Sniff the image MIME type from the file's leading bytes. We
 * deliberately avoid pulling in a MIME-detection library — these
 * four magic numbers are enough for every format we support.
 */
export function sniffImageMediaType(prefix: Buffer): ChatImageMediaType | null {
  if (
    prefix.length >= 8 &&
    prefix[0] === 0x89 &&
    prefix[1] === 0x50 &&
    prefix[2] === 0x4e &&
    prefix[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    prefix.length >= 3 &&
    prefix[0] === 0xff &&
    prefix[1] === 0xd8 &&
    prefix[2] === 0xff
  ) {
    return "image/jpeg";
  }
  // WebP: 'RIFF' .... 'WEBP'
  if (
    prefix.length >= 12 &&
    prefix[0] === 0x52 &&
    prefix[1] === 0x49 &&
    prefix[2] === 0x46 &&
    prefix[3] === 0x46 &&
    prefix[8] === 0x57 &&
    prefix[9] === 0x45 &&
    prefix[10] === 0x42 &&
    prefix[11] === 0x50
  ) {
    return "image/webp";
  }
  // GIF: 'GIF87a' or 'GIF89a'
  if (
    prefix.length >= 6 &&
    prefix[0] === 0x47 &&
    prefix[1] === 0x49 &&
    prefix[2] === 0x46 &&
    prefix[3] === 0x38 &&
    (prefix[4] === 0x37 || prefix[4] === 0x39) &&
    prefix[5] === 0x61
  ) {
    return "image/gif";
  }
  return null;
}

/**
 * Load an image off disk and return a typed content block.
 * Failures (missing file, oversized, unsupported MIME, workspace
 * escape) return `{ ok: false, error }` rather than throwing, so
 * the slash-command dispatcher can render a friendly message
 * instead of crashing the REPL.
 */
export function loadImageAsBlock(
  rawPath: string,
  cwd: string,
): AttachImageResult {
  let resolved: string;
  try {
    const guard = new WorkspaceGuard(cwd);
    resolved = guard.resolve(rawPath, "image");
  } catch (err) {
    return { ok: false, error: `path rejected: ${(err as Error).message}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, error: `file not found: ${rawPath}` };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `not a regular file: ${rawPath}` };
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `image too large: ${stat.size} bytes (cap ${MAX_IMAGE_BYTES}).`,
    };
  }
  if (stat.size === 0) {
    return { ok: false, error: `image is empty: ${rawPath}` };
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(resolved);
  } catch (err) {
    return { ok: false, error: `read failed: ${(err as Error).message}` };
  }

  const mediaType = sniffImageMediaType(bytes.subarray(0, 16));
  if (mediaType == null) {
    return {
      ok: false,
      error:
        `unsupported image format. Supported: PNG, JPEG, WebP, GIF. ` +
        `(File magic did not match.)`,
    };
  }

  const block: ChatContentBlock = {
    type: "image",
    source: {
      kind: "base64",
      mediaType,
      data: bytes.toString("base64"),
    },
  };
  return { ok: true, block, mediaType, bytes: stat.size };
}
