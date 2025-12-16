import path from "node:path";

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

function optionalTrimmedString() {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }, z.string().min(1).optional());
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "t", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "f", "no", "n", "off"].includes(normalized)) return false;

  throw new Error(`Invalid boolean value: ${JSON.stringify(value)}`);
}

function parseInteger(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer value: ${JSON.stringify(value)}`);
  }
  return parsed;
}

const EnvSchema = z.object({
  // Preferred / canonical naming (pick one pair, not both):
  // - YELP_BUSINESS_USERNAME + YELP_BUSINESS_PASSWORD
  // - YELP_BIZ_USERNAME + YELP_BIZ_PASSWORD (supported alias)
  YELP_BUSINESS_USERNAME: optionalTrimmedString(),
  YELP_BUSINESS_PASSWORD: optionalTrimmedString(),
  YELP_BIZ_USERNAME: optionalTrimmedString(),
  YELP_BIZ_PASSWORD: optionalTrimmedString(),

  // Common typo guardrail (we error if set).
  YELP_BUSINESS_USERNMAE: optionalTrimmedString(),

  PORT: optionalTrimmedString(),
  HEADLESS: optionalTrimmedString(),
  SLOW_MO_MS: optionalTrimmedString(),

  ARTIFACTS_DIR: optionalTrimmedString(),
  YELP_BIZ_USER_DATA_DIR: optionalTrimmedString(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

if (parsed.data.YELP_BUSINESS_USERNMAE !== undefined) {
  throw new Error(
    "Found env var YELP_BUSINESS_USERNMAE, which looks like a typo. Did you mean YELP_BUSINESS_USERNAME?",
  );
}

type BizCreds = { username: string; password: string; source: "YELP_BUSINESS_*" | "YELP_BIZ_*" };

function resolveBizCredentials(data: z.infer<typeof EnvSchema>): BizCreds | null {
  const candidates: BizCreds[] = [];

  const hasBusinessUsername = data.YELP_BUSINESS_USERNAME !== undefined;
  const hasBusinessPassword = data.YELP_BUSINESS_PASSWORD !== undefined;
  if (hasBusinessUsername !== hasBusinessPassword) {
    throw new Error(
      "Incomplete biz credentials: set both YELP_BUSINESS_USERNAME and YELP_BUSINESS_PASSWORD.",
    );
  }
  if (hasBusinessUsername && hasBusinessPassword) {
    candidates.push({
      source: "YELP_BUSINESS_*",
      username: data.YELP_BUSINESS_USERNAME!,
      password: data.YELP_BUSINESS_PASSWORD!,
    });
  }

  const hasBizUsername = data.YELP_BIZ_USERNAME !== undefined;
  const hasBizPassword = data.YELP_BIZ_PASSWORD !== undefined;
  if (hasBizUsername !== hasBizPassword) {
    throw new Error("Incomplete biz credentials: set both YELP_BIZ_USERNAME and YELP_BIZ_PASSWORD.");
  }
  if (hasBizUsername && hasBizPassword) {
    candidates.push({
      source: "YELP_BIZ_*",
      username: data.YELP_BIZ_USERNAME!,
      password: data.YELP_BIZ_PASSWORD!,
    });
  }

  if (candidates.length === 0) return null;

  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous Yelp for Business credentials: found multiple credential pairs (${candidates.map((c) => c.source).join(", ")}). Set only one pair.`,
    );
  }

  return candidates[0];
}

const bizCredentials = resolveBizCredentials(parsed.data);

export const env = {
  yelpBiz: {
    credentials: bizCredentials,
    userDataDir: path.resolve(parsed.data.YELP_BIZ_USER_DATA_DIR ?? "state/yelp-biz/user-data"),
  },
  server: {
    port: parseInteger(parsed.data.PORT, 3000),
  },
  playwright: {
    headless: false,
    slowMoMs: parseInteger(parsed.data.SLOW_MO_MS, 250),
  },
  artifactsDir: path.resolve(parsed.data.ARTIFACTS_DIR ?? "artifacts"),
} as const;

if (parsed.data.HEADLESS !== undefined && parseBoolean(parsed.data.HEADLESS, false)) {
  throw new Error(
    "HEADLESS=true is not supported. This service always runs Playwright in headful mode.",
  );
}

export function requireYelpBizCredentials(): { username: string; password: string } {
  const credentials = env.yelpBiz.credentials;
  if (!credentials) {
    throw new Error(
      [
        "Missing Yelp for Business credentials.",
        "Set either (YELP_BUSINESS_USERNAME + YELP_BUSINESS_PASSWORD) or (YELP_BIZ_USERNAME + YELP_BIZ_PASSWORD).",
        "If you prefer not to store passwords, run `npm run auth:biz` to log in manually and persist a session.",
      ].join(" "),
    );
  }
  return { username: credentials.username, password: credentials.password };
}
