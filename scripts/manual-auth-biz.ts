import readline from "node:readline/promises";

import { stdin as input, stdout as output } from "node:process";

import { env } from "../src/env.js";
import { captureDebugArtifacts } from "../src/yelp/debugArtifacts.js";
import { YelpBizClient } from "../src/yelp/biz/yelpBizClient.js";

async function main() {
  const client = new YelpBizClient({
    artifactsDir: env.artifactsDir,
    slowMoMs: env.playwright.slowMoMs,
    userDataDir: env.yelpBiz.userDataDir,
  });

  await client.start();
  const page = client.page();

  await page.goto("https://biz.yelp.com/", { waitUntil: "domcontentloaded" });

  // eslint-disable-next-line no-console
  console.log("");
  // eslint-disable-next-line no-console
  console.log("A browser window should open.");
  // eslint-disable-next-line no-console
  console.log("1) Complete any CAPTCHA / verification.");
  // eslint-disable-next-line no-console
  console.log("2) Log into Yelp for Business normally (including 2FA if prompted).");
  // eslint-disable-next-line no-console
  console.log("3) Once you reach the biz dashboard/inbox, come back here and press Enter.");
  // eslint-disable-next-line no-console
  console.log("");

  const rl = readline.createInterface({ input, output });
  await rl.question("Press Enter to finish and close the browser…");
  rl.close();

  const { dir } = await captureDebugArtifacts(page, {
    artifactsDir: env.artifactsDir,
    label: "biz-manual-auth-finish",
    namespace: "yelp-biz",
  });

  await client.stop();

  // eslint-disable-next-line no-console
  console.log(`Saved debug snapshot: ${dir}`);
  // eslint-disable-next-line no-console
  console.log(`Session data persisted in: ${env.yelpBiz.userDataDir}`);
}

await main();
