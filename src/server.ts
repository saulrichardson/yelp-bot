import Fastify from "fastify";
import { z } from "zod";

import { env } from "./env.js";
import { SerialQueue } from "./lib/serialQueue.js";
import { captureDebugArtifacts } from "./yelp/debugArtifacts.js";
import { YelpBizClient } from "./yelp/biz/yelpBizClient.js";

const server = Fastify({
  logger: true,
});

const yelpBiz = new YelpBizClient({
  artifactsDir: env.artifactsDir,
  slowMoMs: env.playwright.slowMoMs,
  userDataDir: env.yelpBiz.userDataDir,
});

const yelpQueue = new SerialQueue();

server.get("/health", async () => {
  return { ok: true };
});

server.post("/yelp/biz/ensure-auth", async () => {
  await yelpQueue.enqueue(async () => {
    const creds = env.yelpBiz.credentials
      ? { username: env.yelpBiz.credentials.username, password: env.yelpBiz.credentials.password }
      : undefined;

    await yelpBiz.ensureAuthenticated({ credentials: creds });
  });

  return { ok: true };
});

server.get("/yelp/biz/page", async () => {
  const isStarted = await yelpQueue.enqueue(async () => {
    try {
      yelpBiz.page();
      return true;
    } catch {
      return false;
    }
  });

  if (!isStarted) return { started: false };

  const page = yelpBiz.page();
  return { started: true, url: page.url(), title: await page.title() };
});

server.get("/yelp/biz/status", async () => {
  return yelpQueue.enqueue(async () => {
    try {
      const page = yelpBiz.page();

      const url = page.url();
      const title = await page.title().catch(() => null);

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

      const twoFactorVisible = await page
        .locator(
          'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], text=/two[- ]factor|2fa|verification code|authentication code|enter the code/i',
        )
        .first()
        .isVisible()
        .catch(() => false);

      const loginVisible = await page
        .locator(
          'input[data-testid="email"], input[name="email"], input[type="email"], input[data-testid="password"], input[name="password"], input[type="password"]',
        )
        .first()
        .isVisible()
        .catch(() => false);

      let host: string | null = null;
      try {
        host = new URL(url).host;
      } catch {
        host = null;
      }

      return {
        started: true,
        url,
        host,
        title,
        flags: {
          captchaVisible,
          twoFactorVisible,
          loginVisible,
          marketingSite: host === "business.yelp.com",
        },
      };
    } catch {
      return { started: false };
    }
  });
});

server.post("/yelp/biz/navigate", async (request, reply) => {
  const allowedPrefixes = [
    "https://biz.yelp.com/",
    "https://business.yelp.com/",
    "https://www.yelp.com/",
  ];

  const Body = z.object({
    url: z
      .string()
      .url()
      .refine((u) => allowedPrefixes.some((p) => u.startsWith(p)), {
        message: `Only Yelp URLs are allowed: ${allowedPrefixes.join(", ")}`,
      }),
    captureLabel: z.string().min(1).optional(),
  });

  const parsed = Body.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "Invalid request body",
      issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    });
  }

  const result = await yelpQueue.enqueue(async () => {
    await yelpBiz.start();
    await yelpBiz.goto(parsed.data.url);

    const page = yelpBiz.page();
    const artifacts = parsed.data.captureLabel
      ? await captureDebugArtifacts(page, {
          artifactsDir: env.artifactsDir,
          label: parsed.data.captureLabel,
          namespace: "yelp-biz",
        })
      : undefined;

    return {
      url: page.url(),
      title: await page.title(),
      artifactsDir: artifacts?.dir ?? null,
    };
  });

  return result;
});

server.addHook("onClose", async () => {
  await yelpBiz.stop();
});

await server.listen({ port: env.server.port, host: "127.0.0.1" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.log.info({ signal }, "Shutting down");
    void server.close();
  });
}
