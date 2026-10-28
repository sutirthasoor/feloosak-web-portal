# Deploying the Kakkson Booking Server

This server replaces client-side price calculation and client-side
"payment succeeded" trust with server-computed pricing and webhook-verified
payment confirmation. Follow these steps in order.

## 1. Database changes (Supabase)

1. Open your Supabase project -> SQL Editor.
2. Run the contents of `schema.sql` (adds `payments` table and new
   columns on `bookings`).
3. If your `hotels.addons` entries don't already have stable `id` fields,
   run the backfill query commented at the bottom of `schema.sql`.

## 2. Get your Supabase service role key

Project Settings -> API -> `service_role` key (NOT the `anon` key you use
in the frontend). This key bypasses Row Level Security, so:

- It goes ONLY in this server's environment variables.
- Never commit it to git, never put it in the HTML/frontend, never log it.

## 3. Install dependencies locally (to test first)

```bash
cd booking-server
npm install
cp .env.example .env
# edit .env with your real Supabase + Razorpay keys
npm start
```

Confirm it's up: `curl http://localhost:3000/health` should return `{"ok":true}`.

## 4. Deploy somewhere with a public HTTPS URL

Razorpay webhooks require HTTPS. Any of these work well for a small Node app:

- **Render** (render.com) — easiest: connect your git repo, set it as a
  "Web Service", add the env vars from `.env.example` in its dashboard,
  deploy. Free tier is fine to start.
- **Railway** (railway.app) — similar flow, very quick.
- **Fly.io** — more control, still simple (`fly launch`, `fly secrets set ...`).
- A small VPS (DigitalOcean/Linode droplet) with PM2 + nginx + certbot if
  you want full control.

Whichever you pick, set these environment variables in its dashboard
(never commit a real `.env` file):

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
RAZORPAY_KEY_ID
RAZORPAY_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET   (added in step 6 below)
PORT                      (usually set automatically by the host)
```

## 5. Note your server's public URL

e.g. `https://kakkson-booking.onrender.com`

## 6. Register the Razorpay webhook

1. Razorpay Dashboard -> Settings -> Webhooks -> "Add New Webhook".
2. Webhook URL: `https://YOUR-SERVER-URL/webhooks/razorpay`
3. Active events: check `payment.captured` (you can add `payment.failed`
   too if you want to log failed attempts, though the current code only
   acts on `payment.captured`).
4. Save. Razorpay shows you a **webhook secret** at this point — copy it
   into your deployed server's `RAZORPAY_WEBHOOK_SECRET` env var and
   redeploy/restart so it picks it up.

## 7. Point the frontend at your server

In `kakkson_booking.html`, find this line (near the top of the payment
section's script):

```js
const BOOKING_API_BASE = 'https://YOUR-BOOKING-SERVER.example.com';
```

Replace it with your actual deployed URL from step 5, e.g.:

```js
const BOOKING_API_BASE = 'https://kakkson-booking.onrender.com';
```

Re-upload/redeploy the HTML file wherever it's hosted (Netlify, per the
footer credit in the file).

## 8. Lock down CORS

`server.js` currently calls `app.use(cors())`, which allows any origin —
fine for initial testing, not for production. Change it to:

```js
app.use(cors({ origin: 'https://kakksongroup.netlify.app' }));
```

(or your actual production domain).

## 9. Test end to end

1. Open the booking site, go through check-in/check-out, room, meal plan,
   occupancy, guest details.
2. Hit "Confirm Booking & Pay". Check your server logs — you should see
   the `/bookings` POST land, with a price it computed itself.
3. Complete a real (or Razorpay test-mode) payment.
4. Check server logs for `/webhooks/razorpay` receiving `payment.captured`
   and the booking flipping to `confirmed`.
5. Confirm the frontend's polling picks this up and shows the voucher.
6. Test underpayment: temporarily hardcode a smaller `amount` client-side
   to simulate tampering (remove after testing!) and confirm the server
   now computes the REAL price regardless of what the client sent, and
   that the webhook correctly reports `partial_payment` if you test a
   genuinely smaller captured amount (e.g. via Razorpay test mode).

## 10. Use Razorpay test mode first

Before going live, switch `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` to your
test-mode keys and use Razorpay's test card numbers
(https://razorpay.com/docs/payments/payments/test-card-upi-details/) to
verify the whole flow — including underpayment scenarios, which are hard
to trigger with real money — before switching to live keys.

## What changed in kakkson_booking.html

- `processPayment`, `processRazorpayPayment`, `createRazorpayOrder`,
  `createBookingRecord`, `updateBookingWithOrderId`, and
  `updateBookingStatus` were replaced with a flow that calls this server
  instead of computing prices or confirming bookings in the browser.
- The `rzp.on('modal.closed', ...)` handler that previously confirmed a
  booking just from closing the Razorpay popup — with no payment at all —
  has been removed entirely.
- The old `RAZORPAY_ORDER_FUNCTION` / `VERIFY_PAYMENT_FUNCTION` Supabase
  Edge Function URLs are no longer called from the frontend.
