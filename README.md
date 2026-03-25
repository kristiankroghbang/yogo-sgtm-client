# YOGO Booking - sGTM Integration

Server-side Google Tag Manager integration for the [YOGO Booking API](https://api-docs.yogo.dk). Polls all three YOGO API endpoints and sends events to your sGTM container in real time.

**Developed by [Kristian Krogh Bang](https://kristiankroghbang.com) and Claude 4.6.**

---

## What this does

YOGO is a booking and membership platform used by yoga studios, fitness centers, and wellness businesses across Scandinavia. Their API (released 2025) exposes customer, booking, and order data - but has no webhooks.

This project bridges that gap. It consists of two parts:

1. **Poller** (`poller.js`) - A zero-dependency Node.js service that polls the YOGO API every 60 seconds and sends new events to your sGTM endpoint
2. **sGTM Client Template** (`template.tpl`) - A server-side GTM client that receives the events and makes all YOGO data available to your tags

Together, they give you near-real-time server-side tracking of YOGO purchases, bookings, and new customers - without any client-side JavaScript or cookie dependency.

## Why server-side?

YOGO's booking flow runs inside an iframe on your website. You cannot reliably track conversions with client-side JavaScript because:

- The iframe is cross-origin - your GTM container cannot access events inside it
- Ad blockers and ITP/ETP block client-side tracking pixels
- Cookie restrictions make cross-domain attribution unreliable
- You have no control over YOGO's frontend code

Server-side tracking via the API solves all of these problems. The data comes directly from YOGO's database - it is 100% accurate, not sampled, and cannot be blocked.

## Architecture

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
   Railway/Fly.io      |  - Custom tags    |
                       +-------------------+
                        Your sGTM server
```

## Events

The poller sends three event types to sGTM:

### `purchase` (from /orders)
Fired for every new paid order. Includes full order details, line items, and customer data.

| Field | Type | Description |
|-------|------|-------------|
| `event_name` | string | Always `"purchase"` |
| `transaction_id` | string | Invoice number or order ID |
| `value` | number | Total amount including VAT (DKK) |
| `currency` | string | Always `"DKK"` |
| `tax` | number | Total VAT amount |
| `items` | array | Order line items (see below) |
| `user_data` | object | Customer contact details |
| `yogo_order_id` | number | YOGO order ID |
| `yogo_invoice_number` | number | Invoice number |
| `yogo_customer_id` | number | YOGO customer ID |
| `yogo_total_excl_vat` | number | Total excluding VAT |
| `yogo_total_incl_vat` | number | Total including VAT |
| `yogo_total_vat` | number | VAT amount |
| `yogo_paid_at` | string | ISO timestamp of payment |

**Item fields:** `item_id`, `item_name`, `price`, `quantity`, `orderId`, `unitPriceExclVat`, `unitPriceInclVat`, `unitVatAmount`, `totalPriceExclVat`, `totalPriceInclVat`, `totalVatAmount`

### `booking` (from /bookings)
Fired for every new booking (including cancellations). Includes class details and customer data.

| Field | Type | Description |
|-------|------|-------------|
| `event_name` | string | Always `"booking"` |
| `yogo_booking_id` | string | Composite ID (e.g. `studio_123`) |
| `yogo_booking_type` | string | `"studio"` or `"livestream"` |
| `yogo_class_id` | number | Class ID |
| `yogo_class_name` | string | Class name (e.g. "Morning Yoga Flow") |
| `yogo_class_starts_at` | string | Class start time (ISO) |
| `yogo_class_ends_at` | string | Class end time (ISO) |
| `yogo_class_is_cancelled` | boolean | Whether the class was cancelled |
| `yogo_booked_at` | string | When the booking was made (ISO) |
| `yogo_checked_in_at` | string | When customer checked in (ISO, or null) |
| `yogo_cancelled_at` | string | When booking was cancelled (ISO, or null) |

### `new_customer` (from /customers)
Fired for every new customer registration. Includes their full booking and order history.

| Field | Type | Description |
|-------|------|-------------|
| `event_name` | string | Always `"new_customer"` |
| `yogo_customer_id` | number | YOGO customer ID |
| `yogo_bookings` | array | All bookings with class details |
| `yogo_orders` | array | All orders with line items |
| `yogo_booking_count` | number | Total number of bookings |
| `yogo_order_count` | number | Total number of orders |

**All events include `user_data`** with: `email_address`, `phone_number`, `first_name`, `last_name`, `address` (address1, address2, city, postal_code, country).

## Setup

### Prerequisites

- A YOGO Booking account on the **Studio** or **Studio+App** plan with API add-on enabled
- A server-side GTM container (e.g. via [Stape](https://stape.io) or self-hosted)
- A hosting platform for the poller (Railway, Render, Fly.io, or any always-on server)

### 1. Import the sGTM Client Template

1. Open your **GTM Server Container**
2. Go to **Templates** > **Client Templates** > **New**
3. Click the three dots menu > **Import**
4. Upload `template.tpl`
5. Save the template

### 2. Create the Client

1. Go to **Clients** > **New**
2. Select **YOGO Booking - sGTM Client**
3. Set **Request Path Prefix** to `/yogo-` (default)
4. Set **Shared Secret** to a strong random string
5. Save and publish

### 3. Deploy the Poller

#### Railway (recommended)

1. Fork this repo or push to your own GitHub repo
2. Create a new project on [Railway](https://railway.com)
3. Connect your GitHub repo
4. Add environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `YOGO_API_KEY` | Yes | Your YOGO API key |
| `SGTM_URL` | Yes | Your sGTM base URL (e.g. `https://sst.yourdomain.com`) |
| `SGTM_SECRET` | Yes | Must match the shared secret in your sGTM client |
| `POLL_INTERVAL` | No | Seconds between polls (default: 60) |

5. Deploy - Railway will auto-detect Node.js and run `npm start`

#### Other platforms

The poller is a standard Node.js app with zero dependencies. It works on any platform that can run `node poller.js` continuously and set environment variables.

### 4. Create Tags in sGTM

Once the client is receiving events, create tags that fire on the event data. Example trigger:

- **Trigger type:** Custom Event
- **Event name equals:** `purchase` (or `booking`, `new_customer`)

All YOGO fields are available as **Event Data** variables. For example:
- `{{Event Data - yogo_order_id}}`
- `{{Event Data - value}}`
- `{{Event Data - user_data.email_address}}`

## How the poller works

### Cursor-based pagination

The YOGO API uses cursor-based pagination. For orders and customers, the cursor is a numeric ID. For bookings, it is a composite format like `studio_123` or `livestream_456`.

The poller stores the last seen cursor in a local state file (`/tmp/yogo-poller-state.json`). On each poll cycle, it fetches only records after the stored cursor.

### First run behavior

On the very first run (or after a redeploy that clears `/tmp`), the poller fetches all existing records but does **not** send them to sGTM. It only saves the cursor position. This prevents flooding your sGTM container with historical data.

From the second poll onward, only new records are processed and sent.

### Rate limiting

The YOGO API allows 100 requests per minute per client. The poller respects this by:
- Reading the `Retry-After` header on 429 responses
- Waiting the specified duration before retrying
- Using max page size (1000) to minimize requests

### Request timeouts

All HTTP requests (both to YOGO API and sGTM) have a 30-second timeout via `AbortController`. This prevents the poller from hanging indefinitely on network issues.

## Limitations

- **No webhooks** - YOGO's API is read-only with no webhook support. Polling is the only option. The minimum practical interval is ~60 seconds due to the 100 req/min rate limit.
- **No real-time** - There is an inherent delay of up to `POLL_INTERVAL` seconds between an event in YOGO and it reaching sGTM. For most analytics and ad tracking use cases, this is perfectly fine.
- **No historical backfill** - The poller intentionally skips all existing data on first run. If you need historical data, you would need to modify the first-run logic or do a one-time API export.
- **Ephemeral state** - The state file is stored in `/tmp`. On platforms like Railway, this is cleared on redeploy. The poller handles this gracefully (first-run logic kicks in), but you may miss events that occurred between the last poll and the redeploy.
- **Read-only API** - The YOGO API only supports reading data. You cannot create bookings, update customers, or modify orders through the API.
- **DKK currency only** - All monetary values from YOGO are in DKK. The poller hardcodes `currency: 'DKK'` in purchase events.
- **Plan requirement** - API access requires YOGO's Studio or Studio+App plan with the API add-on. Without it, you get 403 Forbidden.

## Security

- **Shared secret validation** - The sGTM client validates an `X-SGTM-Secret` header on every request. Without the correct secret, requests are rejected with 403.
- **No secrets in code** - All credentials are environment variables. The `.gitignore` excludes `.env` files.
- **Zero dependencies** - The poller uses only Node.js built-ins. No `node_modules`, no supply chain risk.
- **HTTPS only** - Both the YOGO API and your sGTM endpoint should use HTTPS. The poller does not disable TLS verification.
- **Minimal health check** - The HTTP health check endpoint only exposes `status` and `uptime`. No internal state, cursors, or API keys are leaked.
- **Startup validation** - The poller validates all required environment variables at startup and exits immediately if any are missing.

## Use cases

- **Conversion tracking** - Send YOGO purchases to GA4, Meta Conversions API, Google Ads, or any other platform via sGTM tags
- **Booking analytics** - Track class popularity, check-in rates, cancellation patterns
- **Customer enrichment** - Feed new customer data to your CRM, email platform, or audience builder
- **Revenue dashboards** - Pipe order data to Looker Studio, BigQuery, or your BI tool via sGTM
- **Remarketing** - Build audiences based on booking behavior (e.g. customers who booked but didn't check in)
- **Multi-touch attribution** - Combine server-side YOGO data with client-side website behavior in GA4

## YOGO API Reference

This integration covers all three endpoints of the YOGO API:

| Endpoint | Method | Pagination | Key parameters |
|----------|--------|------------|----------------|
| `/customers` | GET | Cursor (numeric ID) | `expand`, `limit`, `after` |
| `/bookings` | GET | Cursor (composite) | `from`, `to`, `bookingType`, `includeCancelled`, `expand`, `limit`, `after` |
| `/orders` | GET | Cursor (numeric ID) | `expand`, `limit`, `after` |

Full API documentation: [YOGO API Docs](https://api-docs.yogo.dk)

## License

MIT - see [LICENSE](LICENSE).

## Credits

Built by [Kristian Krogh Bang](https://kristiankroghbang.com) and [Claude 4.6](https://claude.ai) (Anthropic).

This project was created because YOGO finally released their API, and there was no existing sGTM integration for it. If you run a yoga studio, fitness center, or wellness business on YOGO and want proper server-side tracking - this is for you.
