/**
 * optOutClassifier.test.ts
 * Table-driven tests for the Tier-1 CASL opt-out classifier.
 *
 * The design rule under test: opt-out detection MAY over-trigger, it must
 * NEVER under-trigger. Every "must-pass" case here is a legal requirement.
 */
import { describe, it, expect } from "vitest";
import {
  classifyReply,
  isOptOut,
  normalizeReplyText,
  OPT_OUT_PATTERNS,
  OPT_OUT_PATTERNS_EN,
  OPT_OUT_PATTERNS_FR,
  REFERRAL_PATTERNS,
  BARE_STOP_PATTERN,
} from "./optOutClassifier";

// ─── Must-pass opt-outs (English) ────────────────────────────────────────────

describe("isOptOut, must-pass English opt-outs", () => {
  const mustPass = [
    "Not interested.",
    "not interested",
    "No thanks",
    "Remove me",
    "unsubscribe",
    "stop",
    "Stop.",
    "STOP",
    "Don't contact me again",
    "no interest",
    "take my name off",
    "opt me out",
    "Please stop emailing me",
    "quit emailing me",
    "never contact me again",
    "don't email me",
    "lose my number",
    "delete my email",
    "delete my address",
    "delete my info",
    "stop sending me this",
    "I no longer wish to receive these",
    "no more emails please",
    "leave me alone",
    "we don't need this",
    "no thank you",
    "not a fit for us",
    "not the right fit",
  ];

  for (const body of mustPass) {
    it(`detects opt-out: ${JSON.stringify(body)}`, () => {
      expect(isOptOut(body)).toBe(true);
      expect(classifyReply(body)).toBe("OptOut");
    });
  }
});

// ─── Must-pass opt-outs (French, accented and unaccented) ───────────────────

describe("isOptOut, must-pass French opt-outs", () => {
  const mustPass = [
    "Pas intéressé",
    "pas interesse",
    "Désabonnez-moi",
    "Retirez-moi de votre liste",
    "Ne me contactez plus",
    "Non merci",
    "Cessez de m'écrire",
    "arretez",
    "arrêtez",
    "Enlevez-moi de la liste",
    "aucun intérêt",
    "aucun interet",
    "plus de courriels",
    "Veuillez me désabonner de cette liste",
    // Curly apostrophe variant (Outlook / iOS keyboards)
    "Cessez de m’écrire",
  ];

  for (const body of mustPass) {
    it(`detects opt-out: ${JSON.stringify(body)}`, () => {
      expect(isOptOut(body)).toBe(true);
    });
  }
});

// ─── Multi-line and whitespace collapse ──────────────────────────────────────

describe("isOptOut, multi-line bodies", () => {
  it("detects opt-out across paragraphs", () => {
    expect(isOptOut("Not interested.\n\nPlease stop.")).toBe(true);
  });

  it("collapses a line break inside a phrase", () => {
    expect(isOptOut("Not\ninterested")).toBe(true);
  });

  it("collapses tabs and multiple spaces inside a phrase", () => {
    expect(isOptOut("remove \t  me")).toBe(true);
  });
});

// ─── Quoted-reply false positive prevention ──────────────────────────────────

describe("isOptOut, quoted original message is stripped", () => {
  it("ignores 'unsubscribe' that appears only in the quoted original", () => {
    const body =
      "Thanks, this could be interesting. Send me some times.\n\n" +
      "On Mon, Jul 27, 2026 at 9:14 AM Sam Seller <sam@seller.example> wrote:\n" +
      "> Hi Jane,\n" +
      "> ...\n" +
      "> If you'd rather not hear from me, reply unsubscribe and I'll remove you.\n";
    expect(isOptOut(body)).toBe(false);
  });

  it("ignores opt-out text below an Outlook-style 'From:' divider", () => {
    const body =
      "Sounds good, let's talk.\n\n" +
      "From: Sam Seller <sam@seller.example>\n" +
      "Sent: Monday, July 27, 2026\n" +
      "Subject: our outreach\n" +
      "Reply unsubscribe to be removed from our list.\n";
    expect(isOptOut(body)).toBe(false);
  });

  it("ignores opt-out text below '-----Original Message-----'", () => {
    const body =
      "Ok interesting.\n\n-----Original Message-----\nunsubscribe remove me stop\n";
    expect(isOptOut(body)).toBe(false);
  });

  it("ignores opt-out text below an underscore divider", () => {
    const body = "Let's connect.\n\n________________________________\nunsubscribe\n";
    expect(isOptOut(body)).toBe(false);
  });

  it("still detects an opt-out ABOVE the quoted original", () => {
    const body =
      "Unsubscribe me please.\n\nOn Mon, Jul 27, 2026 at 9:14 AM Sam wrote:\n> original pitch\n";
    expect(isOptOut(body)).toBe(true);
  });
});

// ─── Negative controls, must NOT be opt-outs ───────────────────────────────

describe("classifyReply, negative controls", () => {
  it("'Interested, send me a time' is not an opt-out", () => {
    expect(isOptOut("Interested, send me a time")).toBe(false);
    expect(classifyReply("Interested, send me a time")).toBe("None");
  });

  it("'Very interested!' is not an opt-out", () => {
    expect(isOptOut("Very interested!")).toBe(false);
  });

  it("'Not right now, check back in Q1' → NotNow (human review), not suppression", () => {
    const body = "Not right now, check back in Q1";
    expect(isOptOut(body)).toBe(false);
    expect(classifyReply(body)).toBe("NotNow");
  });

  it("'I'm not the right person, talk to Dave' → Referral, not suppression", () => {
    const body = "I'm not the right person, talk to Dave";
    expect(isOptOut(body)).toBe(false);
    expect(classifyReply(body)).toBe("Referral");
  });

  it("'wrong person' → Referral (moved out of opt-out)", () => {
    expect(classifyReply("You've got the wrong person")).toBe("Referral");
  });

  it("'mauvaise personne' → Referral", () => {
    expect(classifyReply("Vous avez la mauvaise personne")).toBe("Referral");
  });

  it("'Can you stop by our office next week?' must not trip bare-stop or stop-patterns", () => {
    const body = "Can you stop by our office next week?";
    expect(isOptOut(body)).toBe(false);
    expect(classifyReply(body)).toBe("None");
  });

  it("empty and quote-only bodies classify as None", () => {
    expect(classifyReply("")).toBe("None");
    expect(classifyReply("On Mon, Jul 27, 2026 Sam wrote:\n> unsubscribe")).toBe("None");
  });
});

// ─── "not looking" tightening ────────────────────────────────────────────────

describe("classifyReply, 'not looking' with and without time qualifiers", () => {
  it("'not looking for new vendors' → OptOut (no time qualifier)", () => {
    expect(classifyReply("We're not looking for new vendors")).toBe("OptOut");
  });

  it("'not looking to switch until Q3' → NotNow (time qualifier present)", () => {
    expect(classifyReply("We're not looking to switch until Q3")).toBe("NotNow");
    expect(isOptOut("We're not looking to switch until Q3")).toBe(false);
  });

  it("'not looking at this before next quarter' → NotNow", () => {
    expect(classifyReply("Not looking at this before next quarter")).toBe("NotNow");
  });

  it("bare 'not looking' without (for|at|to) no longer triggers by itself", () => {
    // The old broad /\bnot looking\b/ pattern is gone; an unanchored "not
    // looking" phrase without a preposition falls through to the LLM backstop.
    expect(classifyReply("we are not looking right now honestly")).not.toBe("OptOut");
  });
});

// ─── Bare stop anchoring ─────────────────────────────────────────────────────

describe("BARE_STOP_PATTERN, anchoring", () => {
  it("matches 'stop', 'Stop.', 'STOP!!' as whole-message bodies", () => {
    expect(isOptOut("stop")).toBe(true);
    expect(isOptOut("Stop.")).toBe(true);
    expect(isOptOut("STOP!!")).toBe(true);
    expect(isOptOut("  stop  ")).toBe(true);
  });

  it("does not match 'stop' mid-sentence", () => {
    expect(BARE_STOP_PATTERN.test("can you stop by our office next week?")).toBe(false);
    expect(isOptOut("The bus stop is around the corner, see you there")).toBe(false);
  });

  it("matches a bare 'stop' whose only other content is a quoted original", () => {
    expect(isOptOut("Stop.\n\nOn Mon, Jul 27, 2026 Sam wrote:\n> pitch")).toBe(true);
  });
});

// ─── Pattern inventory invariants ────────────────────────────────────────────

describe("pattern inventory", () => {
  it("the broken compound /not interested.*stop/ pattern is gone", () => {
    const sources = OPT_OUT_PATTERNS.map((p) => p.source);
    expect(sources.some((s) => s.includes("interested") && s.includes("stop"))).toBe(false);
  });

  it("'wrong person' and 'not the right person' live in REFERRAL, not opt-out", () => {
    const optOutSources = OPT_OUT_PATTERNS.map((p) => p.source).join("\n");
    expect(optOutSources).not.toContain("wrong\\s+person");
    expect(optOutSources).not.toContain("right\\s+person");
    const referralSources = REFERRAL_PATTERNS.map((p) => p.source).join("\n");
    expect(referralSources).toContain("wrong\\s+person");
    expect(referralSources).toContain("not\\s+the\\s+right\\s+person");
  });

  it("combined list is EN + FR", () => {
    expect(OPT_OUT_PATTERNS.length).toBe(
      OPT_OUT_PATTERNS_EN.length + OPT_OUT_PATTERNS_FR.length,
    );
  });
});

// ─── Normalization pipeline ──────────────────────────────────────────────────

describe("normalizeReplyText", () => {
  it("accent-folds and lowercases", () => {
    expect(normalizeReplyText("Désabonnez-Moi")).toBe("desabonnez-moi");
    expect(normalizeReplyText("PAS INTÉRESSÉ")).toBe("pas interesse");
  });

  it("straightens curly apostrophes", () => {
    expect(normalizeReplyText("don’t contact me")).toBe("don't contact me");
  });

  it("collapses all whitespace runs to single spaces", () => {
    expect(normalizeReplyText("not\n\n\t interested ")).toBe("not interested");
  });

  it("keeps only the segment above the first quote marker", () => {
    expect(normalizeReplyText("Top part.\nFrom: someone\nBottom part")).toBe("top part.");
  });
});
