import fs from "node:fs/promises";

import { chromium, type BrowserContext, type Page } from "playwright";

import { captureDebugArtifacts } from "../debugArtifacts.js";

export type YelpBizClientOptions = {
  artifactsDir: string;
  challengeTimeoutMs?: number;
  slowMoMs?: number;
  userDataDir: string;
};

export class YelpBizClient {
  readonly #options: Required<Pick<YelpBizClientOptions, "artifactsDir" | "challengeTimeoutMs" | "userDataDir">> &
    Pick<YelpBizClientOptions, "slowMoMs">;
  #context: BrowserContext | undefined;
  #page: Page | undefined;

  constructor(options: YelpBizClientOptions) {
    this.#options = {
      artifactsDir: options.artifactsDir,
      challengeTimeoutMs: options.challengeTimeoutMs ?? 10 * 60_000,
      slowMoMs: options.slowMoMs,
      userDataDir: options.userDataDir,
    };
  }

  async start(): Promise<void> {
    if (this.#context) return;

    await fs.mkdir(this.#options.userDataDir, { recursive: true });

    this.#context = await chromium.launchPersistentContext(this.#options.userDataDir, {
      headless: false,
      slowMo: this.#options.slowMoMs ?? 0,
      viewport: { width: 1280, height: 800 },
    });
    this.#context.setDefaultTimeout(30_000);
    this.#context.setDefaultNavigationTimeout(45_000);

    this.#page = this.#context.pages()[0] ?? (await this.#context.newPage());
  }

  async stop(): Promise<void> {
    await this.#context?.close();
    this.#context = undefined;
    this.#page = undefined;
  }

  page(): Page {
    if (!this.#page) throw new Error("YelpBizClient not started. Call client.start() first.");
    return this.#page;
  }

  async goto(url: string): Promise<void> {
    const page = this.page();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await this.#maybeDismissOverlays(page);
    await this.#handleChallengesOrBlocks(page, "navigation");
  }

  /**
   * Best-effort auth.
   * - If already logged in (no visible email field), does nothing.
   * - If login form is visible, fills credentials + submits.
   * - If a CAPTCHA/verification is shown, waits for you to complete it in the open browser window.
   */
  async ensureAuthenticated(options?: { credentials?: { username: string; password: string } }): Promise<void> {
    await this.start();
    const page = this.page();

    await this.goto("https://biz.yelp.com/login");

    const isLoginFormVisible = await this.#isEmailPasswordLoginVisible(page);
    if (isLoginFormVisible) {
      if (!options?.credentials) {
        const { dir } = await captureDebugArtifacts(page, {
          artifactsDir: this.#options.artifactsDir,
          label: "biz-login-visible-but-missing-credentials",
          namespace: "yelp-biz",
        });
        throw new Error(
          [
            "Yelp Biz login form is visible but no credentials were provided.",
            "Set env vars (YELP_BUSINESS_USERNAME + YELP_BUSINESS_PASSWORD) or run `npm run auth:biz` to log in manually.",
            `Debug artifacts written to: ${dir}`,
          ].join(" "),
        );
      }

      await this.#login(page, options.credentials);
    }

    // Post-condition: landing on biz portal, not the public marketing site.
    await this.goto("https://biz.yelp.com/");
    const host = new URL(page.url()).host;
    if (host === "business.yelp.com") {
      const { dir } = await captureDebugArtifacts(page, {
        artifactsDir: this.#options.artifactsDir,
        label: "biz-auth-redirected-to-marketing",
        namespace: "yelp-biz",
      });
      throw new Error(
        `Expected to land on biz.yelp.com after auth, but got redirected to business.yelp.com. This usually means you are not authenticated or the account cannot access the biz portal. Debug artifacts written to: ${dir}`,
      );
    }
  }

  async #isEmailPasswordLoginVisible(page: Page): Promise<boolean> {
    const email = page.locator(
      'input[data-testid="email"], input[name="email"], input#email, input[type="email"]',
    );
    return email.first().isVisible().catch(() => false);
  }

  async #login(page: Page, credentials: { username: string; password: string }): Promise<void> {
    await this.#handleChallengesOrBlocks(page, "login-start");

    const email = page.locator(
      'input[data-testid="email"], input[name="email"], input#email, input[type="email"]',
    );
    const password = page.locator(
      'input[data-testid="password"], input[name="password"], input#password, input[type="password"]',
    );

    const hasEmail = await email.first().isVisible().catch(() => false);
    const hasPassword = await password.first().isVisible().catch(() => false);
    if (!hasEmail || !hasPassword) {
      const { dir } = await captureDebugArtifacts(page, {
        artifactsDir: this.#options.artifactsDir,
        label: "biz-login-missing-fields",
        namespace: "yelp-biz",
      });
      throw new Error(
        `Biz login page did not expose expected email/password fields. Debug artifacts written to: ${dir}`,
      );
    }

    await email.first().fill(credentials.username);
    await password.first().fill(credentials.password);

    const submitByRole = page.getByRole("button", { name: /^log in$/i });
    const submitBySelector = page
      .locator('button[type="submit"], input[type="submit"]')
      .filter({ hasText: /log in/i });

    try {
      if (await submitByRole.first().isVisible().catch(() => false)) {
        await submitByRole.first().click();
      } else {
        await submitBySelector.first().click();
      }
    } catch (error) {
      const { dir } = await captureDebugArtifacts(page, {
        artifactsDir: this.#options.artifactsDir,
        label: "biz-login-submit-click-failed",
        namespace: "yelp-biz",
      });
      throw new Error(
        `Failed to click the 'Log in' submit button. Debug artifacts written to: ${dir}. Underlying error: ${String(error)}`,
      );
    }

    // Post-submit: either we become authenticated, or we get an error/verification.
    await page.waitForURL((u) => !u.toString().includes("/login"), {
      timeout: 45_000,
    }).catch(() => undefined);
    await this.#handleChallengesOrBlocks(page, "login-post-submit");

    const stillLoginVisible = await this.#isEmailPasswordLoginVisible(page);
    if (stillLoginVisible) {
      const { dir } = await captureDebugArtifacts(page, {
        artifactsDir: this.#options.artifactsDir,
        label: "biz-login-still-visible",
        namespace: "yelp-biz",
      });
      throw new Error(`Login did not succeed (login form still visible). Debug artifacts written to: ${dir}`);
    }
  }

  async #handleChallengesOrBlocks(page: Page, label: string): Promise<void> {
    await this.#maybeHandleCaptcha(page, label);
    await this.#maybeHandleTwoFactor(page, label);
    await this.#maybeThrowIfBlocked(page, label);
  }

  async #maybeHandleCaptcha(page: Page, label: string): Promise<void> {
    const captchaSelectors = [
      'iframe[src*="captcha-delivery.com" i]', // DataDome (commonly seen on Yelp)
      'iframe[src*="hcaptcha.com" i]',
      'iframe[src*="recaptcha" i]',
      'iframe[title*="captcha" i]',
    ].join(", ");

    const captchaIframes = page.locator(captchaSelectors);
    const iframeCount = await captchaIframes.count().catch(() => 0);

    // We only treat it as an active challenge if the iframe is visibly "large".
    // This avoids false positives from invisible widgets and small sign-in iframes.
    let captchaChallengeVisible = false;
    for (let idx = 0; idx < iframeCount; idx += 1) {
      const box = await captchaIframes.nth(idx).boundingBox().catch(() => null);
      if (!box) continue;
      if (box.width >= 100 && box.height >= 100) {
        captchaChallengeVisible = true;
        break;
      }
    }

    if (!captchaChallengeVisible) return;

    const { dir } = await captureDebugArtifacts(page, {
      artifactsDir: this.#options.artifactsDir,
      label: `captcha-${label}`,
      namespace: "yelp-biz",
    });

    // In headful mode, give the operator (or future AI+operator) a chance to solve it.
    // This intentionally blocks until resolved or timed out.
    await page
      .waitForFunction(
        () => {
          const selectors = [
            'iframe[src*="captcha-delivery.com"]',
            'iframe[src*="hcaptcha.com"]',
            'iframe[src*="recaptcha"]',
            'iframe[title*="CAPTCHA"]',
            'iframe[title*="captcha"]',
          ];
          const frames = Array.from(document.querySelectorAll(selectors.join(",")));

          // Done when there are no *visible large* captcha iframes anymore.
          return frames.every((frame) => {
            const style = window.getComputedStyle(frame);
            if (style.display === "none" || style.visibility === "hidden") return true;

            const rect = frame.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return true;

            // Small widgets/iframes can stick around without requiring operator action.
            return rect.width < 100 || rect.height < 100;
          });
        },
        undefined,
        { timeout: this.#options.challengeTimeoutMs },
      )
      .catch(() => {
        throw new Error(
          `CAPTCHA still present after waiting. Debug artifacts written to: ${dir}`,
        );
      });
  }

  async #maybeHandleTwoFactor(page: Page, label: string): Promise<void> {
    const otpInput = page.locator(
      'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i]',
    );
    const twoFactorText = page.locator(
      "text=/two[- ]factor|2fa|verification code|authentication code|enter the code/i",
    );

    const hasOtp =
      (await otpInput.first().isVisible().catch(() => false)) ||
      (await twoFactorText.first().isVisible().catch(() => false));

    if (!hasOtp) return;

    const { dir } = await captureDebugArtifacts(page, {
      artifactsDir: this.#options.artifactsDir,
      label: `twofactor-${label}`,
      namespace: "yelp-biz",
    });

    await page
      .waitForFunction(
        () => {
          const otpSelectors = [
            'input[autocomplete="one-time-code"]',
            'input[name*="code" i]',
            'input[id*="code" i]',
          ];

          for (const selector of otpSelectors) {
            if (document.querySelector(selector)) return false;
          }

          const bodyText = document.body?.innerText?.toLowerCase() ?? "";
          if (
            bodyText.includes("two-factor") ||
            bodyText.includes("two factor") ||
            bodyText.includes("verification code") ||
            bodyText.includes("authentication code")
          ) {
            return false;
          }

          return true;
        },
        undefined,
        { timeout: this.#options.challengeTimeoutMs },
      )
      .catch(() => {
        throw new Error(
          `Two-factor / verification step still present after waiting. Debug artifacts written to: ${dir}`,
        );
      });
  }

  async #maybeThrowIfBlocked(page: Page, label: string): Promise<void> {
    const url = page.url();
    const likelyBlockUrl = /access-denied|blocked|forbidden|challenge/i.test(url);

    const title = await page.title().catch(() => "");
    const cloudfrontBlockTitle = title.trim().toLowerCase() === "error: the request could not be satisfied";

    const cloudfrontText = page.locator("text=/generated by cloudfront|request could not be satisfied/i");
    const cloudfrontBlockText = await cloudfrontText.first().isVisible().catch(() => false);

    if (!likelyBlockUrl && !cloudfrontBlockTitle && !cloudfrontBlockText) {
      return;
    }

    const { dir } = await captureDebugArtifacts(page, {
      artifactsDir: this.#options.artifactsDir,
      label: `blocked-${label}`,
      namespace: "yelp-biz",
    });

    throw new Error(
      `Yelp Biz appears blocked/unavailable (url=${url}, title=${JSON.stringify(title)}). Debug artifacts written to: ${dir}`,
    );
  }

  async #maybeDismissOverlays(page: Page): Promise<void> {
    const knownSelectors = [
      "#onetrust-accept-btn-handler",
      'button[id="onetrust-accept-btn-handler"]',
    ];

    for (const selector of knownSelectors) {
      const button = page.locator(selector);
      if (await button.first().isVisible().catch(() => false)) {
        await button.first().click().catch(() => undefined);
      }
    }
  }
}
