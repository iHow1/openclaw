import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const TEMP_DIR_PREFIX = "openclaw-xhs-images-";

export interface DownloadedImages {
  cleanup(): Promise<void>;
  paths: string[];
}

export function guessImageExtension(url: string, contentType?: string | null): string {
  const pathname = new URL(url).pathname;
  const ext = path.extname(decodeURIComponent(pathname)).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) {
    return ext;
  }

  const typeMap: Record<string, string> = {
    "image/bmp": ".bmp",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
  };
  for (const [prefix, mapped] of Object.entries(typeMap)) {
    if (contentType?.includes(prefix)) {
      return mapped;
    }
  }

  return ".jpg";
}

function imageRequestHeaders(url: string): HeadersInit {
  const parsed = new URL(url);
  return {
    Referer: `${parsed.protocol}//${parsed.host}/`,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  };
}

export async function downloadImageUrls(
  urls: string[],
  tempDir?: string,
): Promise<DownloadedImages> {
  const ownedDir = tempDir
    ? undefined
    : path.join(os.tmpdir(), `${TEMP_DIR_PREFIX}${randomUUID()}`);
  const outputDir = tempDir ?? ownedDir!;
  await mkdir(outputDir, { recursive: true });

  const downloadedPaths: string[] = [];
  try {
    for (const url of urls) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          headers: imageRequestHeaders(url),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const filePath = path.join(
          outputDir,
          `${randomUUID().replaceAll("-", "").slice(0, 12)}${guessImageExtension(url, response.headers.get("content-type"))}`,
        );
        await writeFile(filePath, Buffer.from(await response.arrayBuffer()));
        downloadedPaths.push(filePath);
      } catch (error) {
        console.error(
          `[xhs-images] Failed to download ${url}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    return {
      cleanup: async () => {
        if (ownedDir) {
          await rm(outputDir, { recursive: true, force: true });
          return;
        }
        await Promise.all(
          downloadedPaths.map(async (filePath) => await rm(filePath, { force: true })),
        );
      },
      paths: downloadedPaths,
    };
  } catch (error) {
    if (ownedDir) {
      await rm(outputDir, { recursive: true, force: true });
    }
    throw error;
  }
}
