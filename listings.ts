/**
 * Listing validation and automated risk checks.
 *
 * Everything here is deterministic and runs inline on submission. The AI
 * checks (scam-pattern classification, photo reuse) are deliberately kept
 * separate — see runAiChecks() at the bottom for the seam where they attach.
 *
 * Design rule: these checks never reject. They produce flags and a score.
 * A human makes the call.
 */

export interface ListingInput {
  landlord_id: string;
  title: string;
  description?: string;
  neighbourhood?: string;
  rent_cents: number;
  bedrooms?: number;
  furnished?: boolean;
  available_from?: string;
  contact_email?: string;
}

export interface RiskFlag {
  check: string;
  severity: "low" | "medium" | "high";
  detail: string;
}

/** Sea-to-Sky areas we accept. Anything else gets flagged, not rejected. */
export const NEIGHBOURHOODS = [
  "Whistler Village",
  "Creekside",
  "Alta Vista",
  "Alpine Meadows",
  "Emerald Estates",
  "Function Junction",
  "Cheakamus Crossing",
  "Spring Creek",
  "Bayshores",
  "Pemberton",
  "Squamish",
  "Other",
] as const;

/**
 * Structural validation. Returns human-readable errors; an empty array means
 * the submission is well-formed (not that it's trustworthy).
 */
export function validateListing(input: Partial<ListingInput>): string[] {
  const errors: string[] = [];

  if (!input.landlord_id?.trim()) errors.push("landlord_id is required");

  const title = input.title?.trim() ?? "";
  if (title.length < 8) errors.push("title must be at least 8 characters");
  if (title.length > 140) errors.push("title must be 140 characters or fewer");

  if (input.description && input.description.length > 5000) {
    errors.push("description must be 5000 characters or fewer");
  }

  if (!Number.isInteger(input.rent_cents) || (input.rent_cents ?? 0) <= 0) {
    errors.push("rent_cents must be a positive integer (cents, not dollars)");
  } else if ((input.rent_cents as number) > 5_000_00 * 100) {
    errors.push("rent_cents is implausibly large — check you sent cents");
  }

  if (input.bedrooms !== undefined) {
    const b = Number(input.bedrooms);
    if (!Number.isFinite(b) || b < 0 || b > 12) {
      errors.push("bedrooms must be between 0 and 12");
    }
  }

  if (input.available_from && !/^\d{4}-\d{2}-\d{2}$/.test(input.available_from)) {
    errors.push("available_from must be YYYY-MM-DD");
  }

  if (input.contact_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.contact_email)) {
    errors.push("contact_email is not a valid email address");
  }

  return errors;
}

/**
 * Deterministic risk checks — no model calls, no network, safe to run inline.
 */
export async function runLocalChecks(
  input: ListingInput,
  db: D1Database
): Promise<RiskFlag[]> {
  const flags: RiskFlag[] = [];
  const text = `${input.title} ${input.description ?? ""}`.toLowerCase();

  // 1. Scam-language heuristics. Crude, but catches the laziest attempts
  //    before spending a model call on them.
  const patterns: Array<[RegExp, string]> = [
    [/\b(out of|outside) (the )?(country|province)\b/, "claims to be away"],
    [/\b(missionar|contract work abroad|overseas assignment)/, "absent-owner story"],
    [/\bwestern union|money ?gram|wire transfer|bitcoin|crypto\b/, "irregular payment method"],
    [/\bwithout (a )?(viewing|seeing)\b|\bno viewing (needed|required)\b/, "discourages viewing"],
    [/\bkeys? (will be |to be )?(couriered|shipped|mailed)\b/, "keys by mail"],
    [/\bfirst come first serve\b.*\bdeposit\b|\bdeposit (today|now|immediately)\b/, "deposit urgency"],
  ];

  for (const [re, detail] of patterns) {
    if (re.test(text)) {
      flags.push({ check: "scam_language", severity: "high", detail });
    }
  }

  // 2. Price plausibility against active listings with the same bedroom count.
  //    Scam listings are priced to attract, so the tail we care about is cheap.
  if (input.bedrooms !== undefined) {
    const row = await db
      .prepare(
        `SELECT AVG(rent_cents) AS avg_rent, COUNT(*) AS n
           FROM listings
          WHERE bedrooms = ?1 AND status = 'active' AND moderation_status = 'approved'`
      )
      .bind(input.bedrooms)
      .first<{ avg_rent: number | null; n: number }>();

    // Need a real sample before the average means anything.
    if (row && row.n >= 8 && row.avg_rent) {
      if (input.rent_cents < row.avg_rent * 0.5) {
        flags.push({
          check: "price_outlier",
          severity: "high",
          detail: `less than half the average for ${input.bedrooms}br listings`,
        });
      } else if (input.rent_cents > row.avg_rent * 2.5) {
        flags.push({
          check: "price_outlier",
          severity: "low",
          detail: `well above the average for ${input.bedrooms}br listings`,
        });
      }
    }
  }

  // 3. Internal consistency: description contradicts the structured field.
  const spelled = text.match(/\b(one|two|three|four|1|2|3|4)[ -]bed/);
  if (spelled && input.bedrooms !== undefined) {
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };
    const claimed = words[spelled[1]] ?? Number(spelled[1]);
    if (Number.isFinite(claimed) && claimed !== input.bedrooms) {
      flags.push({
        check: "inconsistent_fields",
        severity: "medium",
        detail: `description says ${claimed}br, field says ${input.bedrooms}br`,
      });
    }
  }

  // 4. Near-duplicate of an existing listing title (same text, new account).
  const dupe = await db
    .prepare(
      `SELECT id, landlord_id FROM listings
        WHERE lower(title) = lower(?1) AND landlord_id != ?2
        LIMIT 1`
    )
    .bind(input.title.trim(), input.landlord_id)
    .first<{ id: string; landlord_id: string }>();

  if (dupe) {
    flags.push({
      check: "duplicate_title",
      severity: "high",
      detail: `identical title to listing ${dupe.id} from a different landlord`,
    });
  }

  // 5. Unrecognised area — worth a glance, not a rejection.
  if (input.neighbourhood && !NEIGHBOURHOODS.includes(input.neighbourhood as never)) {
    flags.push({
      check: "unknown_neighbourhood",
      severity: "low",
      detail: `"${input.neighbourhood}" is outside the known Sea-to-Sky areas`,
    });
  }

  return flags;
}

/** 0–100. Higher is riskier. Used only to sort your review queue. */
export function scoreFlags(flags: RiskFlag[]): number {
  const weight = { low: 5, medium: 15, high: 35 };
  return Math.min(
    100,
    flags.reduce((sum, f) => sum + weight[f.severity], 0)
  );
}

/**
 * Seam for the AI checks. Not wired up yet — add the Workers AI binding to
 * wrangler.toml ([ai] binding = "AI") and call this from the submit handler
 * via ctx.waitUntil() so a slow model call never blocks the response.
 *
 * Suggested first implementation: pass title + description to a small
 * instruct model with a rubric of known rental-fraud markers, and ask for
 * JSON { score: 0-100, markers: string[] }. Treat the output as one more
 * flag among several, never as a verdict.
 */
export async function runAiChecks(
  _input: ListingInput,
  _ai: unknown
): Promise<RiskFlag[]> {
  return [];
}
