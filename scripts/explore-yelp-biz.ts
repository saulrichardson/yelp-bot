import fs from "node:fs/promises";
import path from "node:path";

import { env } from "../src/env.js";
import { captureDebugArtifacts } from "../src/yelp/debugArtifacts.js";
import { YelpBizClient } from "../src/yelp/biz/yelpBizClient.js";

async function extractInternalLinks(page: ReturnType<YelpBizClient["page"]>) {
  const links = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    return anchors
      .map((a) => {
        const href = a.getAttribute("href") ?? "";
        const text = a.textContent?.trim() ?? "";
        return { href, text };
      })
      .filter((l) => l.href.length > 0);
  });

  const normalized = links
    .map((l) => {
      const href = l.href.trim();
      const absolute = href.startsWith("http")
        ? href
        : href.startsWith("/")
          ? `https://biz.yelp.com${href}`
          : href;
      return { href: absolute, text: l.text };
    })
    .filter((l) => l.href.startsWith("http"));

  const unique = new Map<string, { href: string; text: string }>();
  for (const link of normalized) {
    if (!unique.has(link.href)) unique.set(link.href, link);
  }

  return Array.from(unique.values()).sort((a, b) => a.href.localeCompare(b.href));
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(
    [
      "Note: this runs in headful mode and may pause for CAPTCHA / verification.",
      "If a challenge appears, complete it in the browser window and the script will continue.",
      "",
    ].join("\n"),
  );

  const client = new YelpBizClient({
    artifactsDir: env.artifactsDir,
    slowMoMs: env.playwright.slowMoMs,
    userDataDir: env.yelpBiz.userDataDir,
  });

  try {
    const creds = env.yelpBiz.credentials
      ? { username: env.yelpBiz.credentials.username, password: env.yelpBiz.credentials.password }
      : undefined;
    await client.ensureAuthenticated({ credentials: creds });

    const page = client.page();
    const exploration = {
      visitedAt: new Date().toISOString(),
      pages: [] as Array<{ url: string; title: string; artifactsDir: string; internalLinksCount: number }>,
      notes: [] as string[],
    };

    const visited = new Set<string>();
    const visit = async (label: string, url: string) => {
      if (visited.has(url)) return;
      visited.add(url);

      await client.goto(url);
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);

      const { dir } = await captureDebugArtifacts(page, {
        artifactsDir: env.artifactsDir,
        label: `explore-${label}`,
        namespace: "yelp-biz",
      });

      const links = await extractInternalLinks(page);
      await fs.writeFile(path.join(dir, "internal-links.json"), JSON.stringify(links, null, 2), "utf8");

      exploration.pages.push({
        url: page.url(),
        title: await page.title(),
        artifactsDir: dir,
        internalLinksCount: links.length,
      });

      return { links };
    };

    const home = await visit("home", "https://biz.yelp.com/");

    const interestingLinks =
      home?.links
        ?.filter((l) => {
          const haystack = `${l.href} ${l.text}`.toLowerCase();
          return (
            haystack.includes("inbox") ||
            haystack.includes("message") ||
            haystack.includes("request") ||
            haystack.includes("leads") ||
            haystack.includes("review")
          );
        })
        .slice(0, 8) ?? [];

    for (const [idx, link] of interestingLinks.entries()) {
      await visit(`home-link-${idx + 1}`, link.href);
    }

    const summaryPath = path.join(env.artifactsDir, "yelp-biz", "explore-summary.json");
    await fs.mkdir(path.dirname(summaryPath), { recursive: true });
    await fs.writeFile(summaryPath, JSON.stringify(exploration, null, 2), "utf8");

    // eslint-disable-next-line no-console
    console.log(`Explore complete. Summary: ${summaryPath}`);
    for (const p of exploration.pages) {
      // eslint-disable-next-line no-console
      console.log(`- ${p.title} (${p.url}) -> ${p.artifactsDir}`);
    }
  } finally {
    await client.stop();
  }
}

await main();
