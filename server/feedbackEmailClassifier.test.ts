/**
 * feedbackEmailClassifier.test.ts
 *
 * Coverage: three "departed" examples (adapted from real auto-replies, names
 * and companies changed) extracting the right replacement email, a French NDR classified
 * as bounce, an out-of-office not classified as reply or bounce, a genuine
 * human reply not classified as anything else, plus targeted coverage of
 * the individual sender/subject/body signal groups.
 */
import { describe, it, expect } from "vitest";
import { classifyFeedbackEmail, extractReplacementEmail, extractReturnDate } from "./feedbackEmailClassifier";

describe("classifyFeedbackEmail, bounce (requires a genuine mail-system signal)", () => {
  it("real NDR: postmaster@ sender with body 'wasn't found at' -> bounce", () => {
    const result = classifyFeedbackEmail("postmaster@engineering.example", "Undeliverable", "Your message wasn't found at the destination.");
    expect(result.type).toBe("bounce");
  });

  it("classifies by sender: mailer-daemon", () => {
    const result = classifyFeedbackEmail("MAILER-DAEMON@isp.example", "", "some NDR text");
    expect(result.type).toBe("bounce");
  });

  it("classifies by sender: mailerdaemon (no hyphen)", () => {
    const result = classifyFeedbackEmail("MAILERDAEMON@example.com", "", "some NDR text");
    expect(result.type).toBe("bounce");
  });

  it("classifies by sender: Microsoft Outlook (Exchange NDR display name)", () => {
    const result = classifyFeedbackEmail("Microsoft Outlook <MicrosoftExchange329e@corp.example>", "", "");
    expect(result.type).toBe("bounce");
  });

  it("Exchange-style NDR: MicrosoftExchange sender + 'Undeliverable:' subject -> bounce", () => {
    const result = classifyFeedbackEmail(
      "Microsoft Outlook <MicrosoftExchange329e@corp.example>",
      "Undeliverable: Q3 outreach",
      "Delivery has failed for the following recipient.",
    );
    expect(result.type).toBe("bounce");
  });

  it("classifies by subject: undeliverable / delivery has failed / couldn't be delivered / returned mail / delivery status notification", () => {
    expect(classifyFeedbackEmail("someone@example.com", "Undeliverable: Hello", "").type).toBe("bounce");
    expect(classifyFeedbackEmail("someone@example.com", "Delivery has failed", "").type).toBe("bounce");
    expect(classifyFeedbackEmail("someone@example.com", "Message couldn't be delivered", "").type).toBe("bounce");
    // curly apostrophe variant
    expect(classifyFeedbackEmail("someone@example.com", "Message couldn’t be delivered", "").type).toBe("bounce");
    expect(classifyFeedbackEmail("someone@example.com", "Returned mail: see transcript for details", "").type).toBe("bounce");
    expect(classifyFeedbackEmail("someone@example.com", "Delivery Status Notification (Failure)", "").type).toBe("bounce");
  });

  it("classifies a French NDR as bounce (n'a pas pu etre remis / non remis / introuvable in body, mailer-daemon sender)", () => {
    const body = "Votre message n'a pas pu être remis. Non remis : le destinataire est introuvable.";
    const result = classifyFeedbackEmail("MAILER-DAEMON@isp.example", "Echec de la remise", body);
    expect(result.type).toBe("bounce");
  });

  it("classifies a French NDR as bounce by SUBJECT alone: 'non remis' with no mail-system sender", () => {
    const result = classifyFeedbackEmail("system@some-relay.example.com", "Non remis : votre message", "Ce destinataire est introuvable.");
    expect(result.type).toBe("bounce");
  });

  it("classifies a French NDR as bounce by SUBJECT alone: 'échec de la remise'", () => {
    const result = classifyFeedbackEmail("system@some-relay.example.com", "Échec de la remise du message", "");
    expect(result.type).toBe("bounce");
  });
});

describe("classifyFeedbackEmail, bounce body keywords are corroboration only, never sufficient alone", () => {
  // This is the regression this tightening exists to prevent: a genuine human
  // reply that happens to contain "550" or "recipient not found" must NOT be
  // misclassified as a bounce and cascade Skipped across a live prospect's
  // remaining touches. None of these carry a mail-system sender or a
  // non-delivery subject, so per the tightened rule they must fall through
  // to "reply" (the safe default) even though the body text matches the old
  // (removed) body-trigger patterns.

  it("human reply whose body mentions 550 classifies as reply, NOT bounce", () => {
    const result = classifyFeedbackEmail(
      "prospect@example.com",
      "RE: pricing question",
      "We got a 550 error trying to email your old rep last week, can you resend?",
    );
    expect(result.type).toBe("reply");
  });

  it("human reply mentioning 'recipient not found' conversationally classifies as reply", () => {
    const result = classifyFeedbackEmail(
      "prospect@example.com",
      "RE: your note",
      "Our IT team said recipient not found on their end too, weird. Anyway, let's talk Thursday.",
    );
    expect(result.type).toBe("reply");
  });

  it("body text alone ('wasn't found at' / 'introuvable') with no mail-system sender or subject does not classify as bounce", () => {
    expect(classifyFeedbackEmail("someone@example.com", "", "Your message wasn't found at the destination.").type).not.toBe("bounce");
    expect(classifyFeedbackEmail("system@some-relay.example.com", "", "Ce destinataire est introuvable.").type).not.toBe("bounce");
  });
});

describe("classifyFeedbackEmail, departed (real examples)", () => {
  it("Engineering firm: 'Please note Jon Park is no longer with the firm...' -> jmorris@engineering.example", () => {
    const body = "Please note Jon Park is no longer with the firm. Please contact Jane Morris at jmorris@ENGINEERING.EXAMPLE or 604 555 0142";
    const result = classifyFeedbackEmail("jpark@engineering.example", "Out of Office", body);
    expect(result.type).toBe("departed");
    expect(result.replacementEmail).toBe("jmorris@engineering.example");
  });

  it("Foundations firm: 'Sam Hale has left Example Foundations Canada...' -> e.baker@foundations.example", () => {
    const body =
      "Sam Hale has left Example Foundations Canada. For tender enquiries, please re-direct your email to e.baker@foundations.example";
    const result = classifyFeedbackEmail("shale@foundations.example", "Automatic reply", body);
    expect(result.type).toBe("departed");
    expect(result.replacementEmail).toBe("e.baker@foundations.example");
  });

  it("Energy company: 'This mailbox is no longer in use...' -> transitionteam@energy.example", () => {
    const body = "This mailbox is no longer in use, please contact transitionteam@energy.example";
    const result = classifyFeedbackEmail("someone@energy.example", "Automatic reply", body);
    expect(result.type).toBe("departed");
    expect(result.replacementEmail).toBe("transitionteam@energy.example");
  });

  it("classifies French 'ne travaille plus' as departed", () => {
    const result = classifyFeedbackEmail("jdupont@example.ca", "", "Jean Dupont ne travaille plus ici.");
    expect(result.type).toBe("departed");
  });

  it("excludes the original sender's own address from replacement extraction", () => {
    // Body happens to quote the departed sender's own address alongside the real replacement.
    const body = "jpark@engineering.example is no longer with the firm. Please contact jmorris@engineering.example instead.";
    const result = extractReplacementEmail(body, "jpark@engineering.example");
    expect(result).toBe("jmorris@engineering.example");
  });

  it("departed with no extractable email leaves replacementEmail undefined", () => {
    const result = classifyFeedbackEmail("jpark@engineering.example", "", "Jon Park has left the firm. No forwarding contact provided.");
    expect(result.type).toBe("departed");
    expect(result.replacementEmail).toBeUndefined();
  });
});

describe("classifyFeedbackEmail, ooo", () => {
  it("classifies an out-of-office as ooo, not reply or bounce", () => {
    const body = "I'm currently out of the office and will return on August 15, 2026.";
    const result = classifyFeedbackEmail("prospect@example.com", "Automatic reply", body);
    expect(result.type).toBe("ooo");
    expect(result.type).not.toBe("reply");
    expect(result.type).not.toBe("bounce");
  });

  it("classifies 'on vacation' / 'annual leave' as ooo", () => {
    expect(classifyFeedbackEmail("p@example.com", "", "I am on vacation until further notice.").type).toBe("ooo");
    expect(classifyFeedbackEmail("p@example.com", "", "I am on annual leave this week.").type).toBe("ooo");
  });

  it("classifies French 'absent du bureau' as ooo", () => {
    expect(classifyFeedbackEmail("p@example.com", "", "Je suis absent du bureau jusqu'au 20 aout.").type).toBe("ooo");
  });

  it("extracts a full return date (with year) when present", () => {
    const date = extractReturnDate("I will return on August 15, 2026 with limited access to email.");
    expect(date).toBe("2026-08-15");
  });

  it("does not guess a year when the body has no full date", () => {
    const date = extractReturnDate("I will be back Monday.");
    expect(date).toBeUndefined();
  });
});

describe("classifyFeedbackEmail, reply (safe default)", () => {
  it("classifies a genuine human reply as reply, not bounce/departed/ooo", () => {
    const body = "Thanks for reaching out. Can we set up a call sometime next week to discuss pricing?";
    const result = classifyFeedbackEmail("prospect@example.com", "RE: Quick question", body);
    expect(result.type).toBe("reply");
  });

  it("defaults to reply when body is empty but sender is a real address", () => {
    const result = classifyFeedbackEmail("prospect@example.com", "RE:", "");
    expect(result.type).toBe("reply");
  });
});

describe("classifyFeedbackEmail, unknown", () => {
  it("returns unknown only when there is nothing at all to classify", () => {
    const result = classifyFeedbackEmail("", "", "");
    expect(result.type).toBe("unknown");
  });
});
