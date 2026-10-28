// booking-routes.js
const Razorpay = require('razorpay');
const { calculatePrice } = require('./pricing');
const { checkAvailability } = require('./availability');

function registerBookingRoutes(app, supabase) {
  const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });

  // ---- Create a booking (pending) + a Razorpay order for the server-computed price ----
  app.post('/bookings', async (req, res) => {
    try {
      const {
        hotel_name, checkin, checkout, meal_plan,
        room_configuration,
        addon_ids = [],
        guest_name, guest_email, guest_phone, special_requests,
        payment_method
      } = req.body;

      if (!hotel_name || !checkin || !checkout || !Array.isArray(room_configuration) || room_configuration.length === 0) {
        return res.status(400).json({ error: 'Missing required booking fields' });
      }
      if (new Date(checkin) >= new Date(checkout)) {
        return res.status(400).json({ error: 'Check-out must be after check-in' });
      }
      if (!guest_name || !guest_email || !guest_phone) {
        return res.status(400).json({ error: 'Guest name, email and phone are required' });
      }

      const available = await checkAvailability(supabase, hotel_name, checkin, checkout, room_configuration);
      if (!available) {
        return res.status(409).json({ error: 'Rooms are no longer available for the selected dates' });
      }

      // THE source of truth for price — computed from DB rates, never from the client.
      const pricing = await calculatePrice(supabase, {
        hotelName: hotel_name,
        checkin,
        checkout,
        mealPlan: meal_plan || 'ep',
        roomConfig: room_configuration,
        addonIds: addon_ids
      });

      const bookingNumber = 'KAK-' + Date.now().toString().slice(-6) +
        Math.random().toString(36).substr(2, 3).toUpperCase();

      const { data: booking, error: insertError } = await supabase
        .from('bookings')
        .insert([{
          booking_number: bookingNumber,
          hotel: hotel_name,
          checkin,
          checkout,
          meal_plan: meal_plan || 'ep',
          room_configuration,
          room_type: room_configuration[0].room_type,
          num_rooms: room_configuration.length,
          num_adults: room_configuration[0].num_adults,
          num_children_above_6: room_configuration[0].num_children_above_6 || 0,
          num_children_below_6: room_configuration[0].num_children_below_6 || 0,
          addons_data: pricing.addonDetails,
          guest_name, guest_email, guest_phone,
          special_requests: special_requests || '',
          total_nights: pricing.nights,
          total_amount: pricing.totalRupees,     // server-computed, authoritative
          tax_rate: pricing.taxRate,
          convenience_fee: pricing.convenienceFee,
          payment_method: payment_method || '',
          status: 'pending',                     // not confirmed until the webhook verifies payment
          razorpay_order_id: '',
          remaining_amount: pricing.totalPaise,
          amount_verified: false,
          created_at: new Date().toISOString()
        }])
        .select()
        .single();

      if (insertError) throw insertError;

      const order = await razorpay.orders.create({
        amount: pricing.totalPaise,
        currency: 'INR',
        receipt: bookingNumber,
        notes: { booking_id: bookingNumber, hotel: hotel_name }
      });

      await supabase
        .from('bookings')
        .update({ razorpay_order_id: order.id })
        .eq('booking_number', bookingNumber);

      res.json({
        booking_number: bookingNumber,
        razorpay_order_id: order.id,
        amount: pricing.totalPaise,
        currency: 'INR',
        breakdown: {
          room_charges: pricing.roomCharges,
          addons_charges: pricing.addonsCharges,
          tax_amount: pricing.taxAmount,
          convenience_fee: pricing.convenienceFee,
          total: pricing.totalRupees
        }
      });

    } catch (err) {
      console.error('Booking creation error:', err);
      res.status(400).json({ error: err.message });
    }
  });

  // ---- Poll booking status after payment ----
  app.get('/bookings/:bookingNumber/status', async (req, res) => {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_number', req.params.bookingNumber)
      .single();

    if (error || !booking) return res.status(404).json({ error: 'Booking not found' });

    const expectedPaise = Math.round(booking.total_amount * 100);
    const paidPaise = expectedPaise - (booking.remaining_amount ?? expectedPaise);

    res.json({
      status: booking.status, // 'pending' | 'confirmed' | 'partial_payment'
      expected_paise: expectedPaise,
      paid_paise: booking.status === 'pending' ? 0 : paidPaise,
      remaining_paise: booking.remaining_amount ?? expectedPaise,
      booking
    });
  });

  // ---- Create a top-up Razorpay order for exactly the remaining shortfall ----
  app.post('/bookings/:bookingNumber/topup-order', async (req, res) => {
    try {
      const { data: booking, error } = await supabase
        .from('bookings')
        .select('*')
        .eq('booking_number', req.params.bookingNumber)
        .single();

      if (error || !booking) return res.status(404).json({ error: 'Booking not found' });
      if (booking.status === 'confirmed') return res.status(400).json({ error: 'Booking already confirmed' });

      const remaining = booking.remaining_amount;
      if (!remaining || remaining <= 0) {
        return res.status(400).json({ error: 'No remaining balance on this booking' });
      }

      const order = await razorpay.orders.create({
        amount: remaining,
        currency: 'INR',
        receipt: booking.booking_number + '-TOPUP-' + Date.now(),
        notes: { booking_id: booking.booking_number, type: 'balance_payment' }
      });

      res.json({ order_id: order.id, amount: remaining, currency: 'INR' });

    } catch (err) {
      console.error('Top-up order error:', err);
      res.status(400).json({ error: err.message });
    }
  });
}

module.exports = { registerBookingRoutes };
