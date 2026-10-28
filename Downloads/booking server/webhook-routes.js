// webhook-routes.js
const crypto = require('crypto');
const { calculatePrice } = require('./pricing');
const { deductInventory } = require('./availability');
const { sendVoucherEmailServerSide } = require('./email'); // optional, see email.js

function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false; // length mismatch etc.
  }
}

function registerWebhookRoutes(app, supabase) {
  // IMPORTANT: this route must receive the RAW body (not JSON-parsed) so the
  // HMAC signature can be verified against the exact bytes Razorpay sent.
  // See server.js for how express.raw() is wired up for this path only.
  app.post('/webhooks/razorpay', async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody = req.body; // Buffer

    if (!verifyWebhookSignature(rawBody, signature, process.env.RAZORPAY_WEBHOOK_SECRET)) {
      console.warn('Invalid Razorpay webhook signature');
      return res.status(400).json({ error: 'invalid signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString());
    } catch {
      return res.status(400).json({ error: 'invalid payload' });
    }

    if (payload.event !== 'payment.captured') {
      return res.status(200).json({ ignored: payload.event });
    }

    try {
      const payment = payload.payload.payment.entity;
      const razorpayOrderId = payment.order_id;
      const amountPaid = payment.amount; // paise — Razorpay's own figure, trustworthy

      const { data: booking, error: bookingError } = await supabase
        .from('bookings')
        .select('*')
        .eq('razorpay_order_id', razorpayOrderId)
        .single();

      if (bookingError || !booking) {
        console.error('No booking found for Razorpay order', razorpayOrderId);
        return res.status(200).json({ error: 'booking not found' }); // 200 so Razorpay doesn't endlessly retry
      }

      if (booking.status === 'confirmed') {
        return res.status(200).json({ status: 'already confirmed' });
      }

      // Idempotency guard: skip if we've already recorded this exact payment id.
      const { data: existingPayment } = await supabase
        .from('payments')
        .select('id')
        .eq('razorpay_payment_id', payment.id)
        .maybeSingle();

      if (existingPayment) {
        return res.status(200).json({ status: 'payment already recorded' });
      }

      // Recompute the expected price the SAME way booking-creation did —
      // both import calculatePrice() from pricing.js, so they can't disagree.
      const pricing = await calculatePrice(supabase, {
        hotelName: booking.hotel,
        checkin: booking.checkin,
        checkout: booking.checkout,
        mealPlan: booking.meal_plan,
        roomConfig: booking.room_configuration,
        addonIds: (booking.addons_data || []).map(a => a.id)
      });
      const expectedPaise = pricing.totalPaise;

      const { data: priorPayments } = await supabase
        .from('payments')
        .select('amount_paid')
        .eq('booking_number', booking.booking_number);

      const priorTotal = (priorPayments || []).reduce((sum, p) => sum + p.amount_paid, 0);
      const totalPaidSoFar = priorTotal + amountPaid;

      await supabase.from('payments').insert([{
        booking_number: booking.booking_number,
        razorpay_payment_id: payment.id,
        razorpay_order_id: razorpayOrderId,
        amount_paid: amountPaid,
        captured_at: new Date().toISOString()
      }]);

      if (totalPaidSoFar >= expectedPaise) {
        await supabase
          .from('bookings')
          .update({
            status: 'confirmed',
            amount_verified: true,
            remaining_amount: 0
          })
          .eq('booking_number', booking.booking_number);

        await deductInventory(supabase, booking.hotel, booking.checkin, booking.checkout, booking.room_configuration);

        // Optional: send the voucher from the server too, as a backstop in
        // case the guest's browser never gets the finalize response.
        try { await sendVoucherEmailServerSide(supabase, booking); } catch (e) { console.warn('Voucher email send failed:', e.message); }

        console.log(`✅ Booking ${booking.booking_number} confirmed — paid ${totalPaidSoFar}, expected ${expectedPaise}`);
      } else {
        const remaining = expectedPaise - totalPaidSoFar;
        await supabase
          .from('bookings')
          .update({
            status: 'partial_payment',
            remaining_amount: remaining
          })
          .eq('booking_number', booking.booking_number);

        console.warn(`⚠️ Booking ${booking.booking_number} underpaid — paid ${totalPaidSoFar}, expected ${expectedPaise}, short by ${remaining}`);
      }

      return res.status(200).json({ ok: true });

    } catch (err) {
      console.error('Webhook processing error:', err);
      // Still 200 — a bug on our end shouldn't make Razorpay hammer retries.
      // Make sure this gets logged/alerted somewhere you'll actually see it.
      return res.status(200).json({ error: 'internal, logged' });
    }
  });
}

module.exports = { registerWebhookRoutes };
