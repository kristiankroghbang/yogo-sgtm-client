/**
 * YOGO API -> sGTM Poller
 *
 * Always-on Node.js poller that fetches data from all three YOGO API
 * endpoints (/orders, /customers, /bookings) and sends events to a
 * server-side Google Tag Manager container.
 *
 * Follows the YOGO API documentation exactly:
 * - Cursor-based pagination for /orders and /customers (numeric ID)
 * - Date-range + cursor pagination for /bookings (composite cursor)
 * - Rate limiting with Retry-After header (429)
 * - X-API-KEY authentication
 * - Max 1000 records per page
 *
 * Zero dependencies - uses only Node.js built-ins.
 * Designed to run on Railway, Render, Fly.io, or any always-on host.
 *
 * Environment variables:
 *   YOGO_API_KEY   - API key for YOGO booking API (required)
 *   SGTM_URL       - Base URL to sGTM, e.g. https://sst.yourdomain.com (required)
 *   SGTM_SECRET    - Shared secret for sGTM client authentication (required)
 *   POLL_INTERVAL  - Seconds between each poll cycle (default: 60)
 *   PORT           - Port for health check server (default: 3000)
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
      seenBookingIds: []
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

// --- Map a YOGO order to sGTM event ---
// All fields from the YOGO API /orders docs are included
function mapOrderToEvent(order) {
  const customer = order.customer || {};
  const items = (order.orderItems || []).map((item) => ({
    item_id: String(item.id),
    item_name: item.name,
    price: item.unitPriceInclVat,
    quantity: item.quantity,
    orderId: item.orderId,
    unitPriceExclVat: item.unitPriceExclVat,
    unitPriceInclVat: item.unitPriceInclVat,
    unitVatAmount: item.unitVatAmount,
    totalPriceExclVat: item.totalPriceExclVat,
    totalPriceInclVat: item.totalPriceInclVat,
    totalVatAmount: item.totalVatAmount
  }));

  return {
    event_name: 'purchase',
    transaction_id: String(order.invoiceNumber || order.id),
    value: order.totalAmountInclVat,
    currency: 'DKK',
    tax: order.totalVatAmount,
    items,
    user_data: {
      email_address: customer.email || null,
      phone_number: customer.phone ? customer.phone.replace(/\s/g, '') : null,
      first_name: customer.firstName || null,
      last_name: customer.lastName || null,
      address: {
        address1: customer.address1 || null,
        address2: customer.address2 || null,
        city: customer.city || null,
        postal_code: customer.zipCode || null,
        country: customer.country || 'DK'
      }
    },
    source: 'yogo_api',
    yogo_order_id: order.id,
    yogo_invoice_number: order.invoiceNumber,
    yogo_customer_id: order.customerId,
    yogo_total_excl_vat: order.totalAmountExclVat,
    yogo_total_incl_vat: order.totalAmountInclVat,
    yogo_total_vat: order.totalVatAmount,
    yogo_paid_at: order.paidAt,
    yogo_customer_first_name: customer.firstName,
    yogo_customer_last_name: customer.lastName,
    yogo_customer_email: customer.email,
    yogo_customer_phone: customer.phone,
    yogo_customer_address1: customer.address1,
    yogo_customer_address2: customer.address2,
    yogo_customer_zip: customer.zipCode,
    yogo_customer_city: customer.city,
    yogo_customer_country: customer.country,
    yogo_customer_created_at: customer.createdAt
  };
}

// --- Map a YOGO booking to sGTM event ---
// All fields from the YOGO API /bookings docs are included
function mapBookingToEvent(booking) {
  const cls = booking.class || {};
  const customer = booking.customer || {};

  return {
    event_name: 'booking',
    source: 'yogo_api',
    yogo_booking_id: booking.id,
    yogo_booking_type: booking.bookingType,
    yogo_class_id: booking.classId,
    yogo_customer_id: booking.customerId,
    yogo_booked_at: booking.bookedAt,
    yogo_checked_in_at: booking.checkedInAt,
    yogo_cancelled_at: booking.cancelledAt,
    yogo_class_name: cls.className,
    yogo_class_starts_at: cls.startsAt,
    yogo_class_ends_at: cls.endsAt,
    yogo_class_is_cancelled: cls.isCancelled,
    user_data: {
      email_address: customer.email || null,
      phone_number: customer.phone ? customer.phone.replace(/\s/g, '') : null,
      first_name: customer.firstName || null,
      last_name: customer.lastName || null,
      address: {
        address1: customer.address1 || null,
        address2: customer.address2 || null,
        city: customer.city || null,
        postal_code: customer.zipCode || null,
        country: customer.country || 'DK'
      }
    },
    yogo_customer_first_name: customer.firstName,
    yogo_customer_last_name: customer.lastName,
    yogo_customer_email: customer.email,
    yogo_customer_phone: customer.phone,
    yogo_customer_address1: customer.address1,
    yogo_customer_address2: customer.address2,
    yogo_customer_zip: customer.zipCode,
    yogo_customer_city: customer.city,
    yogo_customer_country: customer.country,
    yogo_customer_created_at: customer.createdAt
  };
}

// --- Map a YOGO customer to sGTM event ---
// All fields from the YOGO API /customers docs are included
function mapCustomerToEvent(customer) {
  const bookings = (customer.bookings || []).map((b) => ({
    yogo_booking_id: b.id,
    yogo_booking_type: b.bookingType,
    yogo_class_id: b.classId,
    yogo_booked_at: b.bookedAt,
    yogo_checked_in_at: b.checkedInAt,
    yogo_cancelled_at: b.cancelledAt,
    yogo_class_name: b.class ? b.class.className : null,
    yogo_class_starts_at: b.class ? b.class.startsAt : null,
    yogo_class_ends_at: b.class ? b.class.endsAt : null
  }));

  const orders = (customer.orders || []).map((o) => ({
    yogo_order_id: o.id,
    yogo_invoice_number: o.invoiceNumber,
    yogo_total_excl_vat: o.totalAmountExclVat,
    yogo_total_incl_vat: o.totalAmountInclVat,
    yogo_total_vat: o.totalVatAmount,
    yogo_paid_at: o.paidAt,
    items: (o.orderItems || []).map((item) => ({
      item_id: String(item.id),
      item_name: item.name,
      quantity: item.quantity,
      orderId: item.orderId,
      unitPriceExclVat: item.unitPriceExclVat,
      unitPriceInclVat: item.unitPriceInclVat,
      unitVatAmount: item.unitVatAmount,
      totalPriceExclVat: item.totalPriceExclVat,
      totalPriceInclVat: item.totalPriceInclVat,
      totalVatAmount: item.totalVatAmount
    }))
  }));

  return {
    event_name: 'new_customer',
    source: 'yogo_api',
    yogo_customer_id: customer.id,
    user_data: {
      email_address: customer.email || null,
      phone_number: customer.phone ? customer.phone.replace(/\s/g, '') : null,
      first_name: customer.firstName || null,
      last_name: customer.lastName || null,
      address: {
        address1: customer.address1 || null,
        address2: customer.address2 || null,
        city: customer.city || null,
        postal_code: customer.zipCode || null,
        country: customer.country || 'DK'
      }
    },
    yogo_customer_first_name: customer.firstName,
    yogo_customer_last_name: customer.lastName,
    yogo_customer_email: customer.email,
    yogo_customer_phone: customer.phone,
    yogo_customer_address1: customer.address1,
    yogo_customer_address2: customer.address2,
    yogo_customer_zip: customer.zipCode,
    yogo_customer_city: customer.city,
    yogo_customer_country: customer.country,
    yogo_customer_created_at: customer.createdAt,
    yogo_bookings: bookings,
    yogo_orders: orders,
    yogo_booking_count: bookings.length,
    yogo_order_count: orders.length
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
  const isFirstRun = state.lastOrderId === null;
  console.log('[orders] Polling... (cursor: ' + (state.lastOrderId || 'none') + (isFirstRun ? ' - FIRST RUN' : '') + ')');

  const orders = await fetchOrders(state.lastOrderId);
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
  const isFirstRun = state.lastCustomerId === null;
  console.log('[customers] Polling... (cursor: ' + (state.lastCustomerId || 'none') + (isFirstRun ? ' - FIRST RUN' : '') + ')');

  const customers = await fetchCustomers(state.lastCustomerId);
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

  // Filter out bookings we have already sent to sGTM
  const newBookings = bookings.filter(b => !seenSet.has(b.id));

  if (!newBookings.length) {
    console.log('[bookings] ' + bookings.length + ' bookings in window, all already seen.');
    return;
  }

  console.log('[bookings] Found ' + newBookings.length + ' new bookings (of ' + bookings.length + ' total in window).');

  for (const booking of newBookings) {
    const event = mapBookingToEvent(booking);
    try {
      await sendToSgtm(event);
      seenSet.add(booking.id);
      const status = booking.cancelledAt ? 'CANCELLED' : (booking.checkedInAt ? 'CHECKED-IN' : 'BOOKED');
      console.log('[bookings] Sent booking ' + booking.id + ' (' + (event.yogo_class_name || 'unknown') + ', ' + status + ') to sGTM');
    } catch (err) {
      console.error('[bookings] Error sending booking ' + booking.id + ':', err.message);
    }
  }

  // Keep only IDs for bookings still in the window to prevent unbounded growth.
  // Bookings for past classes are dropped from the set since they will no longer
  // appear in future API responses anyway.
  const activeIds = new Set(bookings.map(b => b.id));
  state.seenBookingIds = [...seenSet].filter(id => activeIds.has(id));
  console.log('[bookings] Tracking ' + state.seenBookingIds.length + ' seen booking IDs.');
}

// --- Main poll loop ---
async function poll() {
  const state = loadState();

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
  console.log('YOGO -> sGTM poller starting (orders + customers + bookings)');
  console.log('Health check on port ' + PORT);
  console.log('Poll interval: ' + (POLL_INTERVAL / 1000) + 's');
  console.log('sGTM base URL: ' + SGTM_URL);

  poll();
  setInterval(poll, POLL_INTERVAL);
});
