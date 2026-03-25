# YOGO Booking - sGTM Integration

Server-side Google Tag Manager integration for the [YOGO Booking API](https://docs.api.yogobooking.com). Polls all three YOGO API endpoints and sends events to your sGTM container.

Developed by [Kristian Krogh Bang](https://kristiankroghbang.com) and [Claude 4.6](https://claude.ai).

## The problem

YOGO's booking flow runs inside an iframe on your website. Client-side tracking cannot reach it - ad blockers, ITP, and cross-origin restrictions make reliable conversion tracking impossible. The YOGO API has no webhooks.

## The solution

A Node.js poller that watches the YOGO API every 60 seconds and sends new events to your sGTM container. A companion client template receives them.

```
YOGO API  -->  Poller (Node.js)  -->  sGTM Container  -->  GA4 / Meta CAPI / etc.
```

## What's included

| File | Description |
|------|-------------|
| `template.tpl` | sGTM client template - import into GTM Server Container |
| `poller.js` | Node.js poller - deploy on Railway, Render, Fly.io, etc. |
| `metadata.yaml` | GTM Community Template Gallery metadata |

## Events

The poller sends three event types:

- **`purchase`** - New paid orders with line items and customer data (from `/orders`)
- **`booking`** - Class bookings with check-in/cancellation status (from `/bookings`)
- **`new_customer`** - New registrations with booking and order history (from `/customers`)

**Important: orders vs. bookings.** An order (`purchase` event) is triggered when a customer makes an actual payment - buying a membership, a class pass, or similar. A booking (`booking` event) is when a customer reserves a spot in a class. This often happens without a new payment, for example when using an existing membership or class pass. A single order (e.g. a 10-class pass) can lead to many bookings over time, each without generating a new order.

All events include `user_data` (email, phone, name, address) and all raw YOGO API fields prefixed with `yogo_`.

## Setup

### 1. Import the sGTM client

1. In your GTM Server Container, go to **Templates** > **Client Templates** > **New**
2. Click the three dots > **Import** > upload `template.tpl`
3. Create a new **Client**, select **YOGO Booking - sGTM Client**
4. Set a **Shared Secret** (strong random string)
5. Save and publish

### 2. Deploy the poller

Set these environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `YOGO_API_KEY` | Yes | Your YOGO API key |
| `SGTM_URL` | Yes | Your sGTM base URL (e.g. `https://sst.yourdomain.com`) |
| `SGTM_SECRET` | Yes | Must match the shared secret in your sGTM client |
| `POLL_INTERVAL` | No | Seconds between polls (default: 60) |

Then deploy on any always-on host. On Railway: connect your repo and it auto-detects Node.js.

### 3. Create tags in sGTM

All YOGO fields are available as **Event Data** variables:

- `{{Event Data - event_name}}` - `purchase`, `booking`, or `new_customer`
- `{{Event Data - value}}` - Order total (DKK)
- `{{Event Data - yogo_order_id}}` - YOGO order ID
- `{{Event Data - user_data.email_address}}` - Customer email

## How it works

- **Orders and customers** use cursor-based pagination (numeric ID). The poller stores the last seen ID and only fetches records after it. On first run, existing records are skipped to prevent flooding sGTM with historical data.
- **Bookings** work differently. The YOGO `/bookings` endpoint filters by **class start time**, not when the booking was made. A narrow rolling window would miss bookings for future classes and cause duplicates when a class falls inside the window. Instead, the poller fetches a wide window (now to 30 days ahead) on every poll and deduplicates using a stored set of previously seen booking IDs. IDs for past classes are pruned automatically to prevent unbounded growth.
- **Rate limiting** respected (100 req/min, Retry-After header)
- **30s request timeout** via AbortController
- **Zero dependencies** - only Node.js built-ins
- **Shared secret** validation on every request

## Limitations

- **No webhooks** - YOGO API is polling-only. ~60s delay between event and sGTM delivery.
- **No historical backfill** - First run skips existing data by design.
- **Ephemeral state** - Cursor stored in `/tmp`. Resets on redeploy (handled gracefully).
- **Read-only** - Cannot write back to YOGO.
- **DKK only** - All amounts in Danish Kroner.
- **Plan required** - YOGO Studio or Studio+App with API add-on.

## Use cases

- Conversion tracking (GA4, Meta CAPI, Google Ads)
- Booking and check-in analytics
- Revenue attribution and dashboards
- Remarketing audiences based on booking behavior
- Customer data enrichment (CRM, email platforms)

## Resources

- [YOGO API Documentation](https://docs.api.yogobooking.com)
- [sGTM Client Templates Guide](https://developers.google.com/tag-platform/tag-manager/server-side/api)
- [Blog post: Building server-side tracking for YOGO](https://kristiankroghbang.com)

## License

Apache 2.0 - see [LICENSE](LICENSE).
