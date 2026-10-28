// email.js
//
// Optional: sends the voucher email from the server as a backstop, in case
// the guest's browser closes/crashes before the frontend's sendEmailVoucher()
// call runs. This is a stub — wire up your actual email provider here
// (SendGrid, Postmark, AWS SES, etc.) using the booking fields you need.
//
// If you'd rather rely solely on the frontend's EmailJS call after polling
// confirms the booking, you can leave this as a no-op — webhook-routes.js
// already wraps this call in try/catch so a failure here won't break
// payment verification.

async function sendVoucherEmailServerSide(supabase, booking) {
  // Example shape, adjust to your provider's API:
  //
  // await emailClient.send({
  //   to: booking.guest_email,
  //   subject: `Booking Confirmed - ${booking.booking_number}`,
  //   template: 'voucher',
  //   data: {
  //     guest_name: booking.guest_name,
  //     hotel_name: booking.hotel,
  //     booking_number: booking.booking_number,
  //     checkin: booking.checkin,
  //     checkout: booking.checkout,
  //     total_amount: booking.total_amount,
  //     room_type: booking.room_type,
  //     meal_plan: booking.meal_plan
  //   }
  // });

  console.log(`(stub) Would send voucher email to ${booking.guest_email} for ${booking.booking_number}`);
}

module.exports = { sendVoucherEmailServerSide };
