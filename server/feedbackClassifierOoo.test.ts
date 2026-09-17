import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { classifyFeedbackEmail, extractReturnDate } from "./feedbackEmailClassifier";

/**
 * Regression fixtures adapted from four real auto-replies the classifier once
 * misread as genuine replies, which cancelled four live prospects'
 * sequences. Names and companies are changed; the wording that tripped the
 * classifier is kept, typos included. Every one carries the Exchange
 * "Automatic reply:" subject and none matched the old body patterns, which
 * demanded "out of THE office" or "will return".
 */
describe("OOO classification, real misclassified messages", () => {
  const cases = [
    {
      who: "Nora Lee (engineering firm)",
      subject: "Automatic reply: Introduction",
      body: "I am away from the office  and returning August 24. I will be checkinbg messages in the evening. Regards Nora Lee",
    },
    {
      who: "Tom Wade (benefits firm)",
      subject: "Automatic reply: Introduction",
      body: "Please note I’m out of office and will respond to you upon my return, thank you!",
    },
    {
      who: "Bill Grant (accounting firm)",
      subject: "Automatic reply: Introduction",
      body: "Please note I'm away from the office and will be back Monday August 24th. If you need immediate assistance, please contact Dana Park.",
    },
    {
      who: "Rick Barnes (engineering firm)",
      subject: "Automatic reply: Seven offices, one network problem",
      body: "Thank you for your email. I am away and will not be checking emails or Teams. For urgent matters please contact Chris Moss. I will be back Tuesday, September 1.",
    },
  ];

  for (const c of cases) {
    it(`classifies ${c.who} as ooo, not reply`, () => {
      expect(classifyFeedbackEmail("someone@example.com", c.subject, c.body).type).toBe("ooo");
    });
    it(`${c.who} is caught by the BODY alone, without the subject`, () => {
      expect(classifyFeedbackEmail("someone@example.com", "Re: Introduction", c.body).type).toBe("ooo");
    });
  }

  it("catches a bare Automatic reply with an unhelpful body", () => {
    expect(classifyFeedbackEmail("x@y.test", "Automatic reply: Introduction", "Thanks for your note.").type).toBe("ooo");
  });
});

/**
 * The other direction matters just as much: a real human reply read as an
 * absence would keep a live prospect in a cold cadence.
 */
describe("real replies must NOT be classified as ooo", () => {
  it("Mark Bell (construction firm): a genuine soft no", () => {
    const body =
      "Greetings Sam! Summer is always a busy time and I like being busy. I don’t have any ISP searches going on at present. If something pressing appears I will give you a shout, thanks!";
    expect(classifyFeedbackEmail("mark.bell@construction.example", "RE: [External]Connectivity options", body).type).toBe("reply");
  });

  it("Tara Dunn: a real decline that mentions being IN the office", () => {
    const body =
      "We do not have company cell phones, and it doesn’t look like we will anytime in the future, therefore we do not have a need for a wireless plan. Please note I am in the office Monday, Tuesday, Thursday and Friday.";
    expect(classifyFeedbackEmail("tara@insurance.example", "RE: Wireless renewal", body).type).toBe("reply");
  });

  it("Adam Moss: an engaged buyer asking for pricing", () => {
    const body =
      "Hi Sam, Thank you for your email. We will be bringing our own devices (BYOD), so we're mainly interested in the best mobility plan you can offer. What is your best offer?";
    expect(classifyFeedbackEmail("adam.m@builder.example", "Re: Wireless renewal", body).type).toBe("reply");
  });
});

describe("return dates without a year", () => {
  // A year-less date resolves to its next occurrence within 300 days of "now",
  // so pin the clock to the week these fixtures were captured.
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  it("parses 'returning August 24'", () => {
    expect(extractReturnDate("I am away and returning August 24.")).toMatch(/^\d{4}-08-24$/);
  });
  it("parses 'back Monday August 24th'", () => {
    expect(extractReturnDate("I will be back Monday August 24th.")).toMatch(/^\d{4}-08-24$/);
  });
  it("parses 'back Tuesday, September 1'", () => {
    expect(extractReturnDate("I will be back Tuesday, September 1.")).toMatch(/^\d{4}-09-01$/);
  });
  it("still prefers an explicit full date when present", () => {
    expect(extractReturnDate("Away until 2026-12-25, back then.")).toBe("2026-12-25");
  });
  it("returns undefined when there is no date at all", () => {
    expect(extractReturnDate("I am away for a while.")).toBeUndefined();
  });
});
