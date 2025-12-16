import fs from "node:fs/promises";
import path from "node:path";

import type { Page } from "playwright";

function safeSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 80);
}

function isoTimestampForPath(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export async function captureDebugArtifacts(
  page: Page,
  options: { artifactsDir: string; label: string; namespace?: string },
): Promise<{ dir: string }> {
  const now = new Date();
  const namespace = options.namespace ?? "yelp";
  const dir = path.join(
    options.artifactsDir,
    namespace,
    `${isoTimestampForPath(now)}-${safeSegment(options.label)}`,
  );

  await fs.mkdir(dir, { recursive: true });

  const [title, url, html] = await Promise.all([page.title(), page.url(), page.content()]);

  await Promise.all([
    page.screenshot({ path: path.join(dir, "page.png"), fullPage: true }),
    fs.writeFile(path.join(dir, "page.html"), html, "utf8"),
    fs.writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({ capturedAt: now.toISOString(), title, url }, null, 2),
      "utf8",
    ),
  ]);

  return { dir };
}
