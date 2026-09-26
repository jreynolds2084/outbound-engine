# Outbound Beast: core engine

The core of Outbound Beast, the outbound system I built and use in my own enterprise sales work. This repo is the engine:
how sequences get written, how nothing sends without a person approving it, how mail goes out, and how bounces and
replies get read. The web app, scheduler and deployment-specific integrations stay private.

Built with Claude Code. TypeScript, Node.js, MySQL through Drizzle ORM, tested with Vitest.

More builds: [james-reynolds-builds.webflow.io](https://james-reynolds-builds.webflow.io)

## How it works

```mermaid
flowchart LR
  subgraph build["Write the sequence"]
    cfg["Tenant and campaign config"] --> gen["autoSequenceGenerator<br/>LLM-written touches"]
    tpl["fixedTemplates<br/>fixed templates, A/B tracks"] --> queue
    gen --> scrub["scrubber<br/>removes AI tells"]
    scrub --> queue[("outreach_emails<br/>status: Pending")]
  end
  queue --> approve{"A person approves"}
  approve --> gov["sendGovernor<br/>daily ceiling, ramp, monthly cap"]
  gov -->|"over the ceiling"| queue
  gov --> send["Send"]
  send --> gmail["Gmail API"]
  send --> graph["Microsoft Graph"]
  send --> resend["Resend"]
  send --> cadence["followUpCadence<br/>re-anchors the next touches"]
  subgraph inbound["Read what comes back"]
    inbox["Inbox poll"] --> sort["feedbackEmailClassifier<br/>bounce, out of office, departed, reply"]
    inbox --> optout["optOutClassifier<br/>English and French"]
    sort --> bounce["bounceShared<br/>mark bounced, skip pending touches"]
    optout --> agent["replyAgent<br/>suppress, hand to a person, or answer"]
  end
```

## What each part does

| Area | Files | What it does |
|---|---|---|
| Data model | `drizzle/schema.ts` | Tenants (one sending identity each), campaigns, accounts, contacts, outreach emails, calls, LinkedIn tasks and replies. Autopilot is off by default for every tenant and campaign. |
| Writing sequences | `server/autoSequenceGenerator.ts`, `server/fixedTemplates.ts` | LLM-written sequences from tenant config, or fixed per-campaign templates with A/B tracks, unresolved-placeholder checks and per-day staggering. Every touch starts as Pending. |
| Clean copy | `server/scrubber.ts` | Strips em dashes, smart quotes and other AI tells before anything sends. |
| Cadence | `server/followUpCadence.ts`, `server/callScheduler.ts` | Each send re-anchors the contact's remaining touches at 2, 2, 4 and 4 days. Call reminders land on business days, and a person places every call. |
| Volume | `server/sendGovernor.ts` | The ceiling on sends per day, the ramp a new sending configuration climbs over its first three weeks, and the cap on new contacts per month. A brake, not an engine: it reports what may go, defers the rest untouched, and puts follow-ups ahead of first touches so nobody mid-sequence goes quiet. Days and months are counted in the tenant's own timezone, never UTC. |
| Reporting | `server/reporting.ts` | The monthly service report: loaded, queued, sent, awaiting approval, and a search for prospects who fell out of cadence. Distinguishes a stalled prospect from one who replied, bounced or opted out, and from one the volume ceiling deliberately held back. |
| Exit export | `server/exportTenantData.ts` | A tenant's contacts and every piece of outreach copy written for them, as CSV. Includes the opt-out columns, and neutralizes spreadsheet formulas in prospect data. |
| Sending | `server/gmailSender.ts`, `server/microsoftGraph.ts`, `server/emailService.ts` | Gmail API or Microsoft Graph with each tenant's own OAuth token, and Resend for platform mail. Gmail sends check the opt-out list first and refuse to send if that check fails. |
| Unsubscribe | `server/unsubscribe.ts` | Signed one-click unsubscribe links and the RFC 8058 headers that go with them. |
| Bounces | `server/bounceShared.ts` | Pulls the failed address out of a bounce notice, marks the contact Bounced and skips their pending touches. |
| Sorting replies | `server/feedbackEmailClassifier.ts`, `server/optOutClassifier.ts` | Sorts inbound mail into bounce, out of office, departed or reply, and pulls out replacement contacts and return dates. When unsure it calls a message a reply, never a bounce. Opt-out detection covers English and French and errs toward suppression, as Canada's anti-spam law (CASL) requires. |
| Answering replies | `server/replyAgent.ts` | Polls the Microsoft 365 inbox, removes anyone who opts out and confirms it in both languages, hands referrals and "not now" replies to a person, and answers the rest with a booking link. |
| LLM access | `server/_core/llm.ts` | OpenRouter, with Claude Sonnet as the default model. |

## Run the tests

```bash
pnpm install
pnpm test
pnpm check
```

304 tests across 17 files. They need no database, no API keys and no network.

## Configuration

Copy `.env.example` to `.env` and fill in what you use. Sender identity, brand, booking link and OAuth redirect URIs
all come from the environment; nothing about a specific deployment is hardcoded.

## Not included

The React app, API routes, scheduler, data enrichment and deployment-specific integrations. They depend on private
configuration and stay in the private repo.
