/**
 * YOGO API -> sGTM Poller
 *
 * Always-on Node.js poller that fetches data from the YOGO API
 * endpoints (/orders, /customers, /bookings, /memberships) and sends
 * events to a server-side Google Tag Manager container.
 *
 * Follows the YOGO API documentation exactly:
 * - Cursor-based pagination for /orders and /customers (numeric ID)
 * - Date-range + cursor pagination for /bookings (composite cursor)
 * - Status-filtered snapshot + diff for /memberships (status changes)
 * - Rate limiting with Retry-After header (429)
 * - X-API-KEY authentication
 * - Max 1000 records per page
 *
 * Zero dependencies - uses only Node.js built-ins.
 * Designed to run on Railway, Render, Fly.io, or any always-on host.
 *
 * Environment variables:
 *   YOGO_API_KEY         - API key for YOGO booking API (required)
 *   SGTM_URL             - Base URL to sGTM, e.g. https://sst.yourdomain.com (required)
 *   SGTM_SECRET          - Shared secret for sGTM client authentication (required)
 *   POLL_INTERVAL        - Seconds between each poll cycle (default: 60)
 *   PORT                 - Port for health check server (default: 3000)
 *   BACKFILL_MEMBERSHIPS - 'true' = send a membership_status event for ALL live
 *                          memberships on first run (one-time profile backfill).
 *                          State lives in /tmp and resets on every deploy, so
 *                          remove the flag again after the backfill - otherwise
 *                          every deploy re-sends all membership events.
 *
 * Developed by Kristian Krogh Bang and Claude 4.6.
 * https://github.com/kristiankroghbang
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const YOGO_API_KEY = process.env.YOGO_API_KEY;
const SGTM_URL = process.env.SGTM_URL;
const SGTM_SECRET = process.env.SGTM_SECRET;
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '60', 10) * 1000;
const STATE_FILE = path.join('/tmp', 'yogo-poller-state.json');
const BASE_URL = 'https://api.yogobooking.com';
const FETCH_TIMEOUT_MS = 30000;
const BOOKING_WINDOW_DAYS = 30;
const SKIP_INITIAL = process.env.SKIP_INITIAL === 'true';
const BACKFILL_MEMBERSHIPS = process.env.BACKFILL_MEMBERSHIPS === 'true';

// Memberships in these statuses are "live" and diffed for changes every poll.
// 'ended' is never fetched as a list (it grows forever) - a membership that
// disappears from the live lists is looked up individually to get endedReason.
const LIVE_MEMBERSHIP_STATUSES = ['pending', 'active', 'paused', 'cancelled_running'];

// --- Startup validation - fail fast if misconfigured ---
function validateEnv() {
  const missing = [];
  if (!YOGO_API_KEY) missing.push('YOGO_API_KEY');
  if (!SGTM_URL) missing.push('SGTM_URL');
  if (!SGTM_SECRET) missing.push('SGTM_SECRET');
  if (missing.length) {
    console.error('FATAL: Missing required env vars: ' + missing.join(', '));
    process.exit(1);
  }
}

// --- State management (tracks cursors for all endpoints) ---
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      lastOrderId: null,
      lastCustomerId: null,
      seenBookingIds: [],
      // { membershipId: status } snapshot of live memberships. null = first run.
      memberships: null
    };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Could not save state:', err.message);
  }
}

// --- Fetch with timeout (prevents hanging requests) ---
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// --- Generic paginated fetch with rate limit handling (per YOGO API docs) ---
async function fetchPaginated(initialUrl) {
  const allItems = [];
  let url = initialUrl;

  while (url) {
    const res = await fetchWithTimeout(url, {
      headers: { 'X-API-KEY': YOGO_API_KEY }
    });

    // Respect rate limiting per docs (429 with Retry-After header)
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10);
      console.log('Rate limited. Waiting ' + retryAfter + ' seconds...');
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      continue;
    }

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error('YOGO API error: ' + res.status + ' ' + res.statusText + ' - ' + errBody);
    }

    const json = await res.json();
    const items = json.data || [];
    allItems.push(...items);

    // Paginate using hasMore and next URL per YOGO docs
    if (json.hasMore && json.next) {
      url = json.next;
    } else {
      url = null;
    }
  }

  return allItems;
}

// --- Fetch orders with full expansion (per docs: customer, orderItems) ---
async function fetchOrders(afterId) {
  let url = BASE_URL + '/orders?expand=customer,orderItems&limit=1000';
  if (afterId) {
    url += '&after=' + afterId;
  }
  return fetchPaginated(url);
}

// --- Fetch customers with full expansion (per docs: bookings.class, orders.orderItems) ---
async function fetchCustomers(afterId) {
  let url = BASE_URL + '/customers?expand=bookings.class,orders.orderItems&limit=1000';
  if (afterId) {
    url += '&after=' + afterId;
  }
  return fetchPaginated(url);
}

// --- Fetch bookings with date range (required per docs) and expansion ---
async function fetchBookings(from, to) {
  const fromStr = from.toISOString();
  const toStr = to.toISOString();
  let url = BASE_URL + '/bookings?from=' + encodeURIComponent(fromStr) + '&to=' + encodeURIComponent(toStr) + '&expand=class,customer&includeCancelled=true&limit=1000';
  return fetchPaginated(url);
}

// --- E.164 phone formatting (Google EC + Meta CAPI require +<dial><number>) ---
// YOGO usually delivers "+45 12345678", correct after stripping whitespace, but
// edge cases ("00...", missing country code) are handled here. Default dial is
// derived from the customer's country, falling back to DK.
// --- Single-resource GET with the same 429 handling as fetchPaginated ---
// Used for lookups of single resources (customer, ended membership). 404 -> null
// (e.g. a GDPR-deleted customer) instead of failing the whole poll cycle.
async function fetchOne(url) {
  while (true) {
    const res = await fetchWithTimeout(url, {
      headers: { 'X-API-KEY': YOGO_API_KEY }
    });
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10);
      console.log('Rate limited. Waiting ' + retryAfter + ' seconds...');
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      const errBody = await res.text();
      throw new Error('YOGO API error: ' + res.status + ' ' + res.statusText + ' - ' + errBody);
    }
    const json = await res.json();
    return json.data || json;
  }
}

// --- Fetch memberships filtered by status ---
async function fetchMemberships(status) {
  return fetchPaginated(BASE_URL + '/memberships?status=' + status + '&limit=1000');
}

// --- Fetch membership types (small product catalog, for typeId -> name) ---
async function fetchMembershipTypes() {
  return fetchPaginated(BASE_URL + '/membership-types?limit=1000');
}

// --- Fetch a customer's class passes (punch cards) for balance enrichment ---
async function fetchClassPasses(customerId) {
  return fetchPaginated(BASE_URL + '/class-passes?customerId=' + customerId + '&limit=1000');
}

function formatPhoneE164(phoneRaw, countryIso) {
  if (!phoneRaw) return null;
  const phone = String(phoneRaw).replace(/[\s\-()]/g, '');
  if (!phone) return null;

  const dialCodes = {
    dk: '45', se: '46', no: '47', de: '49', gb: '44', us: '1',
    nl: '31', fr: '33', es: '34', it: '39', be: '32', ch: '41',
    at: '43', fi: '358', pl: '48', ie: '353', is: '354'
  };
  const dial = dialCodes[(countryIso || 'dk').toLowerCase()] || '45';

  if (phone.startsWith('+')) return phone;
  if (phone.startsWith('00')) return '+' + phone.substring(2);
  return '+' + dial + phone;
}

// --- Shared helper: build GA4 user_data block (Enhanced Conversions / Customer Match) ---
// Canonical GA4 EC shape: first_name/last_name + street nested inside address.
// _tag_mode "MANUAL" tells the sGTM EC tags the data is pre-formatted server-side, so the
// tag hashes EXACTLY what we send with no normalization of its own. We must therefore
// lowercase AND trim ourselves: Google/Meta normalize (lowercase + strip whitespace) before
// hashing, and YOGO data often carries trailing spaces ("Jacob ", "Frederiksberg "). Without
// trim the tag hashes "jacob " and misses Google's "jacob" -> lost match.
function buildUserData(customer) {
  const norm = (v) => {
    if (!v) return null;
    const s = String(v).trim().toLowerCase();
    return s || null;
  };

  // address1 + address2 are joined into a single street field (GA4 EC has one street field;
  // hashing fails if split). Some customers have the same value in both (or address2 empty);
  // dedupe avoids a "street, street" doublet that breaks address match.
  const a1 = customer.address1 ? String(customer.address1).trim() : '';
  const a2 = customer.address2 ? String(customer.address2).trim() : '';
  const street = [a1, a2 && a2 !== a1 ? a2 : '']
    .filter(Boolean)
    .join(', ')
    .toLowerCase() || null;

  const countryIso = norm(customer.country) || 'dk';

  return {
    _tag_mode: 'MANUAL',
    email_address: norm(customer.email),
    phone_number: formatPhoneE164(customer.phone, countryIso),
    address: {
      first_name: norm(customer.firstName),
      last_name: norm(customer.lastName),
      street,
      city: norm(customer.city),
      region: null,
      postal_code: customer.zipCode ? String(customer.zipCode).trim() : null,
      country: countryIso
    }
  };
}

// Round to 2 decimals (avoid float drift from proportional discount allocation).
function round2(n) {
  return Math.round(n * 100) / 100;
}

// YOGO encodes discounts as orderItems with a negative price:
//  - promo codes, named "Rabatkode: <code>" (the code is delivered WITHOUT quotes), and
//  - redeemed gift cards, named "Gavekort".
// Pull these out of items[] and surface them event-level (GA4 `coupon`) + per-item
// `discount` instead of leaving negative-price lines in the products array.
const COUPON_NAME_RE = /rabatkode\s*:\s*"?(.+?)"?\.?\s*$/i;
const GIFTCARD_NAME_RE = /gavekort/i;

// A SOLD gift card is a positive line (real revenue) and stays a product;
// only a REDEEMED gift card (negative price) counts as a discount.
function isGiftcardLine(item) {
  return !!(item && item.name && GIFTCARD_NAME_RE.test(item.name) && (item.totalPriceInclVat || 0) < 0);
}

function isCouponLine(item) {
  return (!!(item && item.name && COUPON_NAME_RE.test(item.name))) || isGiftcardLine(item);
}

// Coupon label for the GA4 `coupon` field. A promo code takes precedence; a
// redeemed gift card maps to "gavekort".
function extractCoupon(orderItems) {
  for (const item of orderItems) {
    const match = item.name && item.name.match(COUPON_NAME_RE);
    if (match) {
      return match[1].trim();
    }
  }
  for (const item of orderItems) {
    if (isGiftcardLine(item)) {
      return 'gavekort';
    }
  }
  return null;
}

// --- Map a YOGO order to GA4 purchase event ---
// GA4 spec: https://developers.google.com/analytics/devguides/collection/ga4/reference/events#purchase
function mapOrderToEvent(order) {
  const customer = order.customer || {};
  const rawItems = order.orderItems || [];

  // Split the coupon line out of items; surface it as event-level `coupon`.
  const couponCode = extractCoupon(rawItems);
  const productItems = rawItems.filter(function (i) { return !isCouponLine(i); });
  const totalDiscount = rawItems
    .filter(isCouponLine)
    .reduce(function (sum, i) { return sum + Math.abs(i.totalPriceInclVat || 0); }, 0);

  // Allocate the discount proportionally across product items so GA4's
  // per-item `discount` reporting reflects which items were discounted.
  const productSubtotal = productItems.reduce(function (sum, i) {
    return sum + (i.totalPriceInclVat || 0);
  }, 0);

  const items = productItems.map(function (item) {
    const qty = item.quantity || 1;
    const lineRevenue = item.totalPriceInclVat || 0;
    const lineDiscount = (productSubtotal > 0 && totalDiscount > 0)
      ? (lineRevenue / productSubtotal) * totalDiscount
      : 0;
    const unitDiscount = lineDiscount / qty;
    const ga4Item = {
      item_id: String(item.id),
      item_name: item.name,
      price: round2((item.unitPriceInclVat || 0) - unitDiscount),
      quantity: qty
    };
    if (unitDiscount > 0) ga4Item.discount = round2(unitDiscount);
    if (couponCode) ga4Item.coupon = couponCode;
    return ga4Item;
  });

  const event = {
    event_name: 'purchase',
    source: 'yogo_api',
    transaction_id: String(order.invoiceNumber || order.id),
    value: order.totalAmountInclVat,
    currency: 'DKK',
    tax: order.totalVatAmount,
    items: items,
    user_id: customer.id ? String(customer.id) : (order.customerId ? String(order.customerId) : null),
    user_data: buildUserData(customer),
    yogo_order_id: order.id,
    yogo_invoice_number: order.invoiceNumber,
    yogo_total_excl_vat: order.totalAmountExclVat,
    yogo_paid_at: order.paidAt,
    yogo_customer_created_at: customer.createdAt
  };

  if (couponCode) event.coupon = couponCode;

  return event;
}

// --- Map a YOGO booking to sGTM booking event ---
function mapBookingToEvent(booking) {
  const cls = booking.class || {};
  const customer = booking.customer || {};

  return {
    event_name: 'booking',
    source: 'yogo_api',
    user_id: customer.id ? String(customer.id) : (booking.customerId ? String(booking.customerId) : null),
    user_data: buildUserData(customer),
    yogo_booking_id: booking.id,
    yogo_booking_type: booking.bookingType,
    yogo_class_id: booking.classId,
    yogo_booked_at: booking.bookedAt,
    yogo_checked_in_at: booking.checkedInAt,
    yogo_cancelled_at: booking.cancelledAt,
    yogo_class_name: cls.className,
    yogo_class_starts_at: cls.startsAt,
    yogo_class_ends_at: cls.endsAt,
    yogo_class_is_cancelled: cls.isCancelled,
    yogo_customer_created_at: customer.createdAt
  };
}

// --- Map a YOGO customer to sGTM new_customer event ---
function mapCustomerToEvent(customer) {
  const bookings = (customer.bookings || []).map(function (b) {
    return {
      yogo_booking_id: b.id,
      yogo_booking_type: b.bookingType,
      yogo_class_id: b.classId,
      yogo_booked_at: b.bookedAt,
      yogo_checked_in_at: b.checkedInAt,
      yogo_cancelled_at: b.cancelledAt,
      yogo_class_name: b.class ? b.class.className : null,
      yogo_class_starts_at: b.class ? b.class.startsAt : null,
      yogo_class_ends_at: b.class ? b.class.endsAt : null
    };
  });

  const orders = (customer.orders || []).map(function (o) {
    const rawItems = o.orderItems || [];
    const couponCode = extractCoupon(rawItems);
    const productItems = rawItems.filter(function (i) { return !isCouponLine(i); });
    const totalDiscount = rawItems
      .filter(isCouponLine)
      .reduce(function (sum, i) { return sum + Math.abs(i.totalPriceInclVat || 0); }, 0);
    const productSubtotal = productItems.reduce(function (sum, i) {
      return sum + (i.totalPriceInclVat || 0);
    }, 0);

    const orderObj = {
      yogo_order_id: o.id,
      yogo_invoice_number: o.invoiceNumber,
      yogo_total_excl_vat: o.totalAmountExclVat,
      yogo_paid_at: o.paidAt,
      items: productItems.map(function (item) {
        const qty = item.quantity || 1;
        const lineRevenue = item.totalPriceInclVat || 0;
        const lineDiscount = (productSubtotal > 0 && totalDiscount > 0)
          ? (lineRevenue / productSubtotal) * totalDiscount
          : 0;
        const unitDiscount = lineDiscount / qty;
        const ga4Item = {
          item_id: String(item.id),
          item_name: item.name,
          price: round2((item.unitPriceInclVat || 0) - unitDiscount),
          quantity: qty
        };
        if (unitDiscount > 0) ga4Item.discount = round2(unitDiscount);
        if (couponCode) ga4Item.coupon = couponCode;
        return ga4Item;
      })
    };
    if (couponCode) orderObj.coupon = couponCode;
    return orderObj;
  });

  return {
    event_name: 'new_customer',
    source: 'yogo_api',
    user_id: customer.id ? String(customer.id) : null,
    user_data: buildUserData(customer),
    yogo_customer_created_at: customer.createdAt,
    yogo_bookings: bookings,
    yogo_orders: orders,
    yogo_booking_count: bookings.length,
    yogo_order_count: orders.length
  };
}

// --- Class pass balance per customer (from /class-passes) ---
// classesAvailableForBooking is BOOKING capacity: classes that are booked but not
// yet attended are already deducted. That is the right definition for "almost
// empty" reminders. Only valid passes count (validUntil >= today, or null = not
// yet activated); valid_until = the first upcoming expiry.
function buildClassPassSummary(passes) {
  const today = new Date().toISOString().slice(0, 10);
  const active = (passes || []).filter(function (p) { return !p.validUntil || p.validUntil >= today; });
  if (!active.length) return null;
  const clips = active.reduce(function (sum, p) { return sum + (p.classesAvailableForBooking || 0); }, 0);
  const expiries = active.map(function (p) { return p.validUntil; }).filter(Boolean).sort();
  return {
    clips_remaining: clips,
    valid_until: expiries[0] || null
  };
}

// Looks up the customer's class pass balance and sets it top-level on the event
// so an email/CDP tag can map it as a profile property. A SUCCESSFUL lookup with
// no valid passes sends 0/null so a previously positive balance does not go stale
// downstream when the last pass expires. Only on lookup FAILURE are the fields
// omitted (preserving the existing profile value).
async function attachClassPassSummary(event) {
  if (!event.user_id) return;
  try {
    const summary = buildClassPassSummary(await fetchClassPasses(event.user_id));
    event.yogo_clips_remaining = summary ? summary.clips_remaining : 0;
    event.yogo_class_pass_valid_until = summary ? summary.valid_until : null;
  } catch (err) {
    console.error('[class-passes] Lookup failed for customer ' + event.user_id + ':', err.message);
  }
}

// --- Map a membership status change to an sGTM membership_status event ---
// yogo_membership_status / yogo_membership_type sit top-level so a Klaviyo-style
// tag can map them as profile properties. Full details in the flat yogo_* fields.
function mapMembershipToEvent(membership, previousStatus, customer, typeName) {
  const c = customer || {};
  return {
    event_name: 'membership_status',
    source: 'yogo_api',
    user_id: c.id ? String(c.id) : (membership.customerId ? String(membership.customerId) : null),
    user_data: buildUserData(c),
    yogo_membership_status: membership.status,
    yogo_membership_type: typeName || null,
    yogo_membership_id: membership.id,
    yogo_membership_previous_status: previousStatus || null,
    yogo_membership_type_id: membership.membershipTypeId,
    yogo_membership_start_date: membership.startDate || null,
    yogo_membership_cancelled_from_date: membership.cancelledFromDate || null,
    yogo_membership_binding_end_date: membership.bindingEndDate || null,
    // ended_reason: cancelled_by_customer / payment_failed / no_payment_method /
    // cancelled_by_admin. payment_failed + no_payment_method enable dunning flows.
    yogo_membership_ended_reason: membership.endedReason || null,
    yogo_membership_next_payment_date: membership.nextPayment ? membership.nextPayment.date : null,
    yogo_membership_next_payment_amount: membership.nextPayment ? membership.nextPayment.amount : null
  };
}

// --- Send event to sGTM (with timeout) ---
async function sendToSgtm(eventData) {
  const endpoint = SGTM_URL + '/yogo-' + eventData.event_name;
  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SGTM-Secret': SGTM_SECRET
    },
    body: JSON.stringify(eventData)
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error('sGTM error (' + endpoint + '): ' + res.status + ' ' + res.statusText + ' - ' + errBody);
  }

  return res.status;
}

// --- Poll orders ---
async function pollOrders(state) {
  // Treat 0 as first run too - SKIP_INITIAL sets lastOrderId=0 which would
  // otherwise fetch all orders via ?after=0 and send them all to sGTM.
  const isFirstRun = state.lastOrderId === null || state.lastOrderId === 0;
  console.log('[orders] Polling... (cursor: ' + (state.lastOrderId || 'none') + (isFirstRun ? ' - FIRST RUN' : '') + ')');

  // YOGO returns 422 INVALID_CURSOR if the cursor ID no longer exists
  // (e.g. order deleted). Reset to null - next poll runs as first-run,
  // walks to latest ID, and skips historical events.
  let orders;
  try {
    orders = await fetchOrders(isFirstRun ? null : state.lastOrderId);
  } catch (err) {
    if (err.message && err.message.includes('INVALID_CURSOR')) {
      console.warn('[orders] Cursor ' + state.lastOrderId + ' is invalid - resetting to null (next poll = first-run).');
      state.lastOrderId = null;
      return;
    }
    throw err;
  }
  if (!orders.length) {
    console.log('[orders] No new orders.');
    return;
  }

  if (isFirstRun) {
    const lastId = orders[orders.length - 1].id;
    state.lastOrderId = lastId;
    console.log('[orders] First run: skipping ' + orders.length + ' existing orders. Cursor: ' + lastId);
    return;
  }

  const paidOrders = orders.filter(o => o.paidAt);
  console.log('[orders] Found ' + paidOrders.length + ' paid orders (of ' + orders.length + ' total).');

  for (const order of paidOrders) {
    const event = mapOrderToEvent(order);
    // Include class pass balance on purchase (updates the profile when a punch card is bought).
    await attachClassPassSummary(event);
    try {
      await sendToSgtm(event);
      console.log('[orders] Sent order #' + event.transaction_id + ' (' + event.value + ' DKK) to sGTM');
    } catch (err) {
      console.error('[orders] Error sending order #' + order.id + ':', err.message);
    }
  }

  const lastId = orders[orders.length - 1].id;
  state.lastOrderId = lastId;
  console.log('[orders] Cursor updated: ' + lastId);
}

// --- Poll customers ---
async function pollCustomers(state) {
  // Treat 0 as first run too - SKIP_INITIAL sets lastCustomerId=0 which would
  // otherwise fetch all customers via ?after=0 and send them all to sGTM.
  const isFirstRun = state.lastCustomerId === null || state.lastCustomerId === 0;
  console.log('[customers] Polling... (cursor: ' + (state.lastCustomerId || 'none') + (isFirstRun ? ' - FIRST RUN' : '') + ')');

  // YOGO returns 422 INVALID_CURSOR if the cursor ID no longer exists
  // (e.g. customer deleted/GDPR-anonymized). Reset to null - next poll runs
  // as first-run, walks to latest ID, and skips historical events.
  let customers;
  try {
    customers = await fetchCustomers(isFirstRun ? null : state.lastCustomerId);
  } catch (err) {
    if (err.message && err.message.includes('INVALID_CURSOR')) {
      console.warn('[customers] Cursor ' + state.lastCustomerId + ' is invalid - resetting to null (next poll = first-run).');
      state.lastCustomerId = null;
      return;
    }
    throw err;
  }
  if (!customers.length) {
    console.log('[customers] No new customers.');
    return;
  }

  if (isFirstRun) {
    const lastId = customers[customers.length - 1].id;
    state.lastCustomerId = lastId;
    console.log('[customers] First run: skipping ' + customers.length + ' existing customers. Cursor: ' + lastId);
    return;
  }

  console.log('[customers] Found ' + customers.length + ' new customers.');

  for (const customer of customers) {
    const event = mapCustomerToEvent(customer);
    try {
      await sendToSgtm(event);
      console.log('[customers] Sent customer #' + customer.id + ' (' + customer.firstName + ' ' + customer.lastName + ') to sGTM');
    } catch (err) {
      console.error('[customers] Error sending customer #' + customer.id + ':', err.message);
    }
  }

  const lastId = customers[customers.length - 1].id;
  state.lastCustomerId = lastId;
  console.log('[customers] Cursor updated: ' + lastId);
}

// --- Poll bookings ---
// NOTE: The YOGO /bookings endpoint filters by CLASS start time, not by when
// the booking was made. A narrow rolling window would miss most bookings and
// cause duplicates when a class falls inside the window. Instead, we fetch a
// wide window (today -> 30 days ahead) on every poll and deduplicate using a
// set of previously seen booking IDs stored in state.
async function pollBookings(state) {
  const now = new Date();
  const future = new Date(now.getTime() + BOOKING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const seenSet = new Set(state.seenBookingIds || []);

  console.log('[bookings] Polling classes from ' + now.toISOString() + ' to ' + future.toISOString() + ' (seen: ' + seenSet.size + ' bookings)...');

  const bookings = await fetchBookings(now, future);
  if (!bookings.length) {
    console.log('[bookings] No bookings found in window.');
    return;
  }

  // Treat as first run if the set is empty OR if it only contains the
  // SKIP_INITIAL sentinel '_initialized' (which never matches real booking IDs
  // and would cause ALL bookings to be sent as "new").
  var isFirstRun = seenSet.size === 0 || (seenSet.size === 1 && seenSet.has('_initialized'));

  // First run: save all existing booking IDs without sending to sGTM.
  // Same logic as orders/customers - prevents flooding sGTM with historical data.
  if (isFirstRun) {
    seenSet.clear();
    state.seenBookingIds = bookings.map(b => b.id);
    console.log('[bookings] First run: skipping ' + bookings.length + ' existing bookings.');
    return;
  }

  // Filter out bookings we have already sent to sGTM
  const newBookings = bookings.filter(b => !seenSet.has(b.id));

  if (!newBookings.length) {
    console.log('[bookings] ' + bookings.length + ' bookings in window, all already seen.');
    return;
  }

  console.log('[bookings] Found ' + newBookings.length + ' new bookings (of ' + bookings.length + ' total in window).');

  for (const booking of newBookings) {
    const event = mapBookingToEvent(booking);
    // Include class pass balance on booking - booking is the moment the balance
    // changes, so the profile's yogo_clips_remaining stays current here.
    await attachClassPassSummary(event);
    // Always mark as seen to prevent infinite retry loops.
    // Failed sends are logged but not retried every poll cycle.
    seenSet.add(booking.id);
    try {
      await sendToSgtm(event);
      const status = booking.cancelledAt ? 'CANCELLED' : (booking.checkedInAt ? 'CHECKED-IN' : 'BOOKED');
      console.log('[bookings] Sent booking ' + booking.id + ' (' + (event.yogo_class_name || 'unknown') + ', ' + status + ') to sGTM');
    } catch (err) {
      console.error('[bookings] Error sending booking ' + booking.id + ' (marked as seen, will not retry):', err.message);
    }
  }

  // Keep only IDs for bookings still in the window to prevent unbounded growth.
  // Bookings for past classes are dropped from the set since they will no longer
  // appear in future API responses anyway.
  const activeIds = new Set(bookings.map(b => b.id));
  state.seenBookingIds = [...seenSet].filter(id => activeIds.has(id));
  console.log('[bookings] Tracking ' + state.seenBookingIds.length + ' seen booking IDs.');
}

// --- Poll memberships (snapshot + diff) ---
// /memberships has no "changed since" cursor, so every poll fetches the live
// statuses (pending/active/paused/cancelled_running - a small set) and diffs
// against the previous snapshot. An ID that disappears from the live lists has
// ended -> individual lookup to get endedReason (payment_failed etc.) on the event.
async function pollMemberships(state) {
  const current = {};
  for (const status of LIVE_MEMBERSHIP_STATUSES) {
    const rows = await fetchMemberships(status);
    for (const m of rows) current[m.id] = m;
  }

  const stored = state.memberships;
  const isFirstRun = stored === null || stored === undefined;
  console.log('[memberships] Polling... (' + Object.keys(current).length + ' live, ' + (isFirstRun ? 'FIRST RUN' : Object.keys(stored).length + ' in snapshot') + ')');

  // Collect changes: new memberships, status transitions, and endings.
  const changes = [];
  if (isFirstRun) {
    if (BACKFILL_MEMBERSHIPS) {
      // One-time backfill: send current status for every live membership so
      // downstream profiles get yogo_membership_status from day one.
      for (const m of Object.values(current)) changes.push({ membership: m, previous: null });
      console.log('[memberships] BACKFILL: sending status for ' + changes.length + ' live memberships.');
    } else {
      state.memberships = Object.fromEntries(Object.entries(current).map(function (e) { return [e[0], e[1].status]; }));
      console.log('[memberships] First run: snapshot saved, no events sent.');
      return;
    }
  } else {
    for (const [id, m] of Object.entries(current)) {
      const prev = stored[id];
      if (!prev) {
        changes.push({ membership: m, previous: null });
      } else if (prev !== m.status) {
        changes.push({ membership: m, previous: prev });
      }
    }
    for (const [id, prevStatus] of Object.entries(stored)) {
      if (!current[id]) {
        // Gone from the live lists -> look up for status=ended + endedReason.
        // null (404/deleted) is skipped.
        const ended = await fetchOne(BASE_URL + '/memberships/' + id);
        if (ended && ended.status === 'ended') {
          changes.push({ membership: ended, previous: prevStatus });
        }
      }
    }
  }

  if (changes.length) {
    // typeId -> name for yogo_membership_type (small catalog, fetched only on changes).
    let typeMap = new Map();
    try {
      const types = await fetchMembershipTypes();
      typeMap = new Map(types.map(function (t) { return [t.id, t.name]; }));
    } catch (err) {
      console.error('[memberships] Could not fetch membership types:', err.message);
    }

    console.log('[memberships] ' + changes.length + ' status changes.');
    for (const { membership, previous } of changes) {
      // Customer lookup for user_data (email is the profile key downstream).
      let customer = null;
      try {
        customer = await fetchOne(BASE_URL + '/customers/' + membership.customerId);
      } catch (err) {
        console.error('[memberships] Customer lookup failed for ' + membership.customerId + ':', err.message);
      }
      const event = mapMembershipToEvent(membership, previous, customer, typeMap.get(membership.membershipTypeId));
      try {
        await sendToSgtm(event);
        console.log('[memberships] Sent membership #' + membership.id + ' (' + (previous || 'new') + ' -> ' + membership.status + (membership.endedReason ? ', ' + membership.endedReason : '') + ') to sGTM');
      } catch (err) {
        // No retry (same principle as bookings): the snapshot is updated below regardless.
        console.error('[memberships] Error sending membership #' + membership.id + ':', err.message);
      }
    }
  } else if (!isFirstRun) {
    console.log('[memberships] No changes.');
  }

  state.memberships = Object.fromEntries(Object.entries(current).map(function (e) { return [e[0], e[1].status]; }));
}

// --- Main poll loop ---
// In-progress guard: if a cycle takes longer than POLL_INTERVAL (e.g. timeouts on
// customer lookups), setInterval must not start another one on top - two concurrent
// cycles would read the same snapshot and send membership_status events twice.
let pollInProgress = false;

async function poll() {
  if (pollInProgress) {
    console.log('[poll] Previous cycle still running - skipping this one.');
    return;
  }
  pollInProgress = true;
  try {
    await runPollCycle();
  } finally {
    pollInProgress = false;
  }
}

async function runPollCycle() {
  const state = loadState();

  // SKIP_INITIAL: If set and state is empty, mark as initialized without
  // fetching any historical data. Avoids paginating through thousands of
  // records on first run. Safe to leave set - only applies when state has no cursors.
  if (SKIP_INITIAL && state.lastOrderId === null) {
    state.lastOrderId = 0;
    state.lastCustomerId = 0;
    state.seenBookingIds = ['_initialized'];
    saveState(state);
    console.log('[init] SKIP_INITIAL: state initialized. Will only capture new events from next poll.');
    return;
  }

  try {
    await pollOrders(state);
  } catch (err) {
    console.error('[orders] Poll error:', err.message, err.cause || '');
  }

  try {
    await pollCustomers(state);
  } catch (err) {
    console.error('[customers] Poll error:', err.message, err.cause || '');
  }

  try {
    await pollBookings(state);
  } catch (err) {
    console.error('[bookings] Poll error:', err.message, err.cause || '');
  }

  try {
    await pollMemberships(state);
  } catch (err) {
    console.error('[memberships] Poll error:', err.message, err.cause || '');
  }

  saveState(state);
}

// --- Health check server ---
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'running', uptime: process.uptime() }));
});

// --- Start ---
validateEnv();

server.listen(PORT, () => {
  console.log('YOGO -> sGTM poller starting (orders + customers + bookings + memberships)');
  console.log('Health check on port ' + PORT);
  console.log('Poll interval: ' + (POLL_INTERVAL / 1000) + 's');
  console.log('sGTM base URL: ' + SGTM_URL);

  poll();
  setInterval(poll, POLL_INTERVAL);
});
