import { env } from "../src/env.js";
import { YelpBizClient } from "../src/yelp/biz/yelpBizClient.js";

async function main() {
  const client = new YelpBizClient({
    artifactsDir: env.artifactsDir,
    slowMoMs: env.playwright.slowMoMs,
    userDataDir: env.yelpBiz.userDataDir,
  });

  try {
    await client.start();
    const page = client.page();
    await page.goto("https://biz.yelp.com/login", { waitUntil: "domcontentloaded" });

    const emailVisible = await page
      .locator('input[name="email"], input[type="email"]')
      .first()
      .isVisible()
      .catch(() => false);
    const passwordVisible = await page
      .locator('input[name="password"], input[type="password"]')
      .first()
      .isVisible()
      .catch(() => false);
    const captchaVisible = await (async () => {
      const captchaSelectors = [
        'iframe[src*="captcha-delivery.com" i]',
        'iframe[src*="hcaptcha.com" i]',
        'iframe[src*="recaptcha" i]',
        'iframe[title*="captcha" i]',
      ].join(", ");
      const iframes = page.locator(captchaSelectors);
      const count = await iframes.count().catch(() => 0);
      for (let idx = 0; idx < count; idx += 1) {
        const box = await iframes.nth(idx).boundingBox().catch(() => null);
        if (!box) continue;
        if (box.width >= 100 && box.height >= 100) return true;
      }
      return false;
    })();

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: true,
          url: page.url(),
          title: await page.title(),
          loginFieldsVisible: { email: emailVisible, password: passwordVisible },
          captchaVisible,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.stop();
  }
}

await main();
