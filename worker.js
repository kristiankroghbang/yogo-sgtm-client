/**
 * YOGO API -> sGTM Poller (Cloudflare Workers)
 *
 * Cloudflare Worker with Cron Trigger that polls all three YOGO API
 * endpoints (/orders, /customers, /bookings) and sends events to a
 * server-side Google Tag Manager container.
 *
 * Advantages over the Node.js poller:
 * - Persistent state via KV (survives deploys)
 * - No always-on server cost (runs only when triggered)
 * - Free tier covers most use cases (100k requests/day)
 *
 * Setup:
 *   1. Create a KV namespace and bind it as YOGO_STATE in wrangler.toml
 *   2. Set secrets: wrangler secret put YOGO_API_KEY / SGTM_URL / SGTM_SECRET
 *   3. Deploy: wrangler deploy
 *
 * Developed by Kristian Krogh Bang and Claude 4.6.
 * https://github.com/kristiankroghbang
 */

var BASE_URL = 'https://api.yogobooking.com';
var FETCH_TIMEOUT_MS = 25000;
var BOOKING_WINDOW_DAYS = 30;

// --- State management via KV (persistent across deploys) ---
async function loadState(kv) {
  var state = await kv.get('poller-state', { type: 'json' });
  return state || {
    lastOrderId: null,
    lastCustomerId: null,
    seenBookingIds: []
  };
}

async function saveState(kv, state) {
  await kv.put('poller-state', JSON.stringify(state));
}

// --- Fetch with timeout ---
async function fetchWithTimeout(url, options) {
  var controller = new AbortController();
  var timeout = setTimeout(function() { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timeout);
  }
}

// --- Paginated fetch with rate limit handling (per YOGO API docs) ---
async function fetchPaginated(initialUrl, apiKey) {
  var allItems = [];
  var url = initialUrl;

  while (url) {
    var res = await fetchWithTimeout(url, {
      headers: { 'X-API-KEY': apiKey }
    });

    if (res.status === 429) {
      var retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10);
      console.log('Rate limited. Waiting ' + retryAfter + ' seconds...');
      await new Promise(function(resolve) { setTimeout(resolve, retryAfter * 1000); });
      continue;
    }

    if (!res.ok) {
      var errBody = await res.text();
      throw new Error('YOGO API error: ' + res.status + ' ' + res.statusText + ' - ' + errBody);
    }

    var json = await res.json();
    var items = json.data || [];
    allItems = allItems.concat(items);

    if (json.hasMore && json.next) {
      url = json.next;
    } else {
      url = null;
    }
  }

  return allItems;
}

// --- Fetch endpoints ---
function fetchOrders(afterId, apiKey) {
  var url = BASE_URL + '/orders?expand=customer,orderItems&limit=1000';
  if (afterId) url += '&after=' + afterId;
  return fetchPaginated(url, apiKey);
}

function fetchCustomers(afterId, apiKey) {
  var url = BASE_URL + '/customers?expand=bookings.class,orders.orderItems&limit=1000';
  if (afterId) url += '&after=' + afterId;
  return fetchPaginated(url, apiKey);
}

function fetchBookings(from, to, apiKey) {
  var url = BASE_URL + '/bookings?from=' + encodeURIComponent(from.toISOString()) + '&to=' + encodeURIComponent(to.toISOString()) + '&expand=class,customer&includeCancelled=true&limit=1000';
  return fetchPaginated(url, apiKey);
}

// --- Map order to sGTM event ---
function mapOrderToEvent(order) {
  var customer = order.customer || {};
  var items = (order.orderItems || []).map(function(item) {
    return {
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
    };
  });

  return {
    event_name: 'purchase',
    transaction_id: String(order.invoiceNumber || order.id),
    value: order.totalAmountInclVat,
    currency: 'DKK',
    tax: order.totalVatAmount,
    items: items,
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

// --- Map booking to sGTM event ---
function mapBookingToEvent(booking) {
  var cls = booking.class || {};
  var customer = booking.customer || {};

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

// --- Map customer to sGTM event ---
function mapCustomerToEvent(customer) {
  var bookings = (customer.bookings || []).map(function(b) {
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

  var orders = (customer.orders || []).map(function(o) {
    return {
      yogo_order_id: o.id,
      yogo_invoice_number: o.invoiceNumber,
      yogo_total_excl_vat: o.totalAmountExclVat,
      yogo_total_incl_vat: o.totalAmountInclVat,
      yogo_total_vat: o.totalVatAmount,
      yogo_paid_at: o.paidAt,
      items: (o.orderItems || []).map(function(item) {
        return {
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
        };
      })
    };
  });

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

// --- Send event to sGTM ---
async function sendToSgtm(eventData, sgtmUrl, sgtmSecret) {
  var endpoint = sgtmUrl + '/yogo-' + eventData.event_name;
  var res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SGTM-Secret': sgtmSecret
    },
    body: JSON.stringify(eventData)
  });

  if (!res.ok) {
    var errBody = await res.text();
    throw new Error('sGTM error (' + endpoint + '): ' + res.status + ' ' + res.statusText + ' - ' + errBody);
  }
  return res.status;
}

// --- Poll functions ---
async function pollOrders(state, env) {
  var isFirstRun = state.lastOrderId === null;
  console.log('[orders] Polling... (cursor: ' + (state.lastOrderId || 'none') + (isFirstRun ? ' - FIRST RUN' : '') + ')');

  var orders = await fetchOrders(state.lastOrderId, env.YOGO_API_KEY);
  if (!orders.length) { console.log('[orders] No new orders.'); return; }

  if (isFirstRun) {
    state.lastOrderId = orders[orders.length - 1].id;
    console.log('[orders] First run: skipping ' + orders.length + ' existing. Cursor: ' + state.lastOrderId);
    return;
  }

  var paidOrders = orders.filter(function(o) { return o.paidAt; });
  console.log('[orders] Found ' + paidOrders.length + ' paid orders (of ' + orders.length + ' total).');

  for (var i = 0; i < paidOrders.length; i++) {
    var event = mapOrderToEvent(paidOrders[i]);
    try {
      await sendToSgtm(event, env.SGTM_URL, env.SGTM_SECRET);
      console.log('[orders] Sent order #' + event.transaction_id + ' (' + event.value + ' DKK)');
    } catch (err) {
      console.error('[orders] Error sending order #' + paidOrders[i].id + ':', err.message);
    }
  }

  state.lastOrderId = orders[orders.length - 1].id;
}

async function pollCustomers(state, env) {
  var isFirstRun = state.lastCustomerId === null;
  console.log('[customers] Polling... (cursor: ' + (state.lastCustomerId || 'none') + (isFirstRun ? ' - FIRST RUN' : '') + ')');

  var customers = await fetchCustomers(state.lastCustomerId, env.YOGO_API_KEY);
  if (!customers.length) { console.log('[customers] No new customers.'); return; }

  if (isFirstRun) {
    state.lastCustomerId = customers[customers.length - 1].id;
    console.log('[customers] First run: skipping ' + customers.length + ' existing. Cursor: ' + state.lastCustomerId);
    return;
  }

  console.log('[customers] Found ' + customers.length + ' new customers.');

  for (var i = 0; i < customers.length; i++) {
    var event = mapCustomerToEvent(customers[i]);
    try {
      await sendToSgtm(event, env.SGTM_URL, env.SGTM_SECRET);
      console.log('[customers] Sent customer #' + customers[i].id);
    } catch (err) {
      console.error('[customers] Error sending customer #' + customers[i].id + ':', err.message);
    }
  }

  state.lastCustomerId = customers[customers.length - 1].id;
}

async function pollBookings(state, env) {
  var now = new Date();
  var future = new Date(now.getTime() + BOOKING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  var seenSet = new Set(state.seenBookingIds || []);

  console.log('[bookings] Polling classes from ' + now.toISOString() + ' to ' + future.toISOString() + ' (seen: ' + seenSet.size + ')...');

  var bookings = await fetchBookings(now, future, env.YOGO_API_KEY);
  if (!bookings.length) { console.log('[bookings] No bookings in window.'); return; }

  if (seenSet.size === 0) {
    state.seenBookingIds = bookings.map(function(b) { return b.id; });
    console.log('[bookings] First run: skipping ' + bookings.length + ' existing bookings.');
    return;
  }

  var newBookings = bookings.filter(function(b) { return !seenSet.has(b.id); });
  if (!newBookings.length) {
    console.log('[bookings] ' + bookings.length + ' in window, all already seen.');
    return;
  }

  console.log('[bookings] Found ' + newBookings.length + ' new bookings (of ' + bookings.length + ' total).');

  for (var i = 0; i < newBookings.length; i++) {
    var event = mapBookingToEvent(newBookings[i]);
    try {
      await sendToSgtm(event, env.SGTM_URL, env.SGTM_SECRET);
      seenSet.add(newBookings[i].id);
      console.log('[bookings] Sent booking ' + newBookings[i].id);
    } catch (err) {
      console.error('[bookings] Error sending booking ' + newBookings[i].id + ':', err.message);
    }
  }

  var activeIds = new Set(bookings.map(function(b) { return b.id; }));
  state.seenBookingIds = Array.from(seenSet).filter(function(id) { return activeIds.has(id); });
}

// --- Worker entry point ---
export default {
  // Cron Trigger handler - runs on schedule
  async scheduled(event, env, ctx) {
    var state = await loadState(env.YOGO_STATE);

    // SKIP_INITIAL: If set and state is empty, mark as initialized without
    // fetching any historical data. This avoids paginating through thousands
    // of records on first run, which can exceed CF Workers subrequest limits.
    // Safe to leave set - only applies when state has no cursors.
    if (env.SKIP_INITIAL === 'true' && state.lastOrderId === null) {
      state.lastOrderId = 0;
      state.lastCustomerId = 0;
      state.seenBookingIds = ['_initialized'];
      await saveState(env.YOGO_STATE, state);
      console.log('[init] SKIP_INITIAL: state initialized. Will only capture new events from next poll.');
      return;
    }

    try { await pollOrders(state, env); }
    catch (err) { console.error('[orders] Poll error:', err.message); }

    try { await pollCustomers(state, env); }
    catch (err) { console.error('[customers] Poll error:', err.message); }

    try { await pollBookings(state, env); }
    catch (err) { console.error('[bookings] Poll error:', err.message); }

    await saveState(env.YOGO_STATE, state);
  },

  // HTTP handler - health check
  async fetch(request, env, ctx) {
    var state = await loadState(env.YOGO_STATE);
    return new Response(JSON.stringify({
      status: 'running',
      lastOrderId: state.lastOrderId,
      lastCustomerId: state.lastCustomerId,
      seenBookings: (state.seenBookingIds || []).length
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
