# I Built a Server-Side GTM Integration for YOGO Booking (And Open-Sourced It)

YOGO finally released their API. Here is how I built a server-side tracking pipeline for it - and why you probably need one too if you are running a studio on YOGO.

---

## The problem

If you run a yoga studio, fitness center, or wellness business on YOGO, you have probably noticed something frustrating: you cannot properly track conversions.

YOGO's booking flow runs inside an iframe on your website. Your Google Tag Manager container cannot reach into that iframe. Client-side tracking scripts get blocked by ad blockers and browser privacy features (ITP, ETP). And cookie restrictions make cross-domain attribution unreliable at best.

The result? You are spending money on ads but have no reliable way to measure which ones actually drive bookings and revenue.

## The YOGO API changes everything

In 2025, YOGO released a proper REST API. It exposes three endpoints:

- **/customers** - Customer profiles with contact details
- **/bookings** - Class bookings with check-in and cancellation data
- **/orders** - Purchases with line items and payment status

This means you can now pull booking and purchase data directly from YOGO's database - no iframes, no cookies, no client-side JavaScript.

## What I built

I built two things:

### 1. A poller that watches for new YOGO events

Since the YOGO API has no webhooks, I wrote a lightweight Node.js service that polls all three endpoints every 60 seconds. When it finds new paid orders, bookings, or customer registrations, it sends them to a server-side GTM endpoint.

The poller:
- Uses cursor-based pagination (exactly as the YOGO API docs specify)
- Respects rate limits (100 requests/minute)
- Skips historical data on first run (no flooding your analytics)
- Has zero npm dependencies (just Node.js built-ins)
- Runs on Railway, Render, Fly.io, or any always-on host

### 2. An sGTM client template that receives the events

The companion sGTM client template claims incoming requests from the poller, validates a shared secret, and passes all YOGO data straight through to your server container. No transformation, no opinionated mapping - just the raw data, available as event data for whatever tags you want to fire.

From there, you can send it to GA4, Meta Conversions API, Google Ads, your CRM, a BigQuery dataset - whatever your tracking stack needs.

## How it works

```
YOGO Booking System
        |
        | (API polling every 60s)
        v
  +------------+       POST /yogo-purchase
  |   Poller   | ----> +-------------------+
  | (Node.js)  | ----> | sGTM Container    |
  |            | ----> |  - GA4 tag        |
  +------------+       |  - Meta CAPI tag  |
   Railway             |  - Custom tags    |
                       +-------------------+
                        Your sGTM server
```

1. Customer books a class or buys a membership on your YOGO-powered website
2. The poller picks up the new order/booking from the YOGO API within 60 seconds
3. The event is sent to your sGTM container with all customer and order details
4. Your sGTM tags fire - GA4 purchase event, Meta CAPI conversion, whatever you need

## What you can do with it

- **Conversion tracking that actually works** - No more guessing. Every YOGO purchase shows up in GA4 and your ad platforms as a proper conversion with revenue data.
- **Booking analytics** - Track which classes are most popular, check-in rates, cancellation patterns. All server-side, all accurate.
- **Remarketing audiences** - Build audiences based on actual booking behavior. Target people who booked but did not check in, or who have not booked in 30 days.
- **Revenue attribution** - Finally answer "which ad campaign drove the most YOGO revenue?" with real data.
- **Customer enrichment** - Pipe new customer registrations to your email platform or CRM automatically.

## Things to know

**It is not real-time.** There is up to a 60-second delay between an event in YOGO and it reaching sGTM. For analytics and ad tracking, this is perfectly fine. For time-critical triggers, it might not be.

**No historical backfill.** The poller intentionally skips existing data on first deployment. This prevents flooding your analytics with months of old events. If you need historical data, you would need to modify the first-run behavior.

**YOGO API has no webhooks.** Polling is the only option. The 100 req/min rate limit means 60 seconds is about the fastest practical interval.

**You need the right YOGO plan.** API access requires the Studio or Studio+App plan with the API add-on. Check with YOGO if you are not sure.

**State is ephemeral.** The poller stores its cursor in `/tmp`. On platforms like Railway, this resets on redeploy. The poller handles this gracefully (re-syncs the cursor), but you might miss events during the brief window between last poll and redeploy.

## Get it

The entire project is open source under the MIT license:

**GitHub:** [github.com/kristiankroghbang/yogo-sgtm-client](https://github.com/kristiankroghbang/yogo-sgtm-client)

The README has full setup instructions for both the poller and the sGTM client template.

---

If you are a YOGO studio owner or a developer working with YOGO clients, I hope this saves you the headache I went through figuring out server-side tracking for an iframe-based booking system. Feel free to open issues or PRs on GitHub.

*Built by [Kristian Krogh Bang](https://kristiankroghbang.com) and Claude 4.6.*
