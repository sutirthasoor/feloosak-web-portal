// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const { registerBookingRoutes } = require('./booking-routes');
const { registerWebhookRoutes } = require('./webhook-routes');

const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET'
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error('Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

const app = express();

app.use(cors()); // tighten this to your actual frontend origin in production, see README

// IMPORTANT: the webhook route needs the RAW request body to verify
// Razorpay's signature, so express.raw() is applied to that path only,
// BEFORE the global express.json() below.
app.use('/webhooks/razorpay', express.raw({ type: 'application/json' }));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // service role — server-only, bypasses RLS, never expose to the frontend
);

registerBookingRoutes(app, supabase);
registerWebhookRoutes(app, supabase);

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Booking server listening on port ${PORT}`);
});
