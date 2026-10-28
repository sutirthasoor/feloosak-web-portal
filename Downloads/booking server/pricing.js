// pricing.js
//
// This module is the ONLY place booking prices get calculated.
// Both the booking-creation endpoint and the payment webhook import
// and call calculatePrice() so they can never disagree with each other,
// and the browser never gets to supply a price directly.

function getDatesBetween(checkin, checkout) {
  const dates = [];
  let current = new Date(checkin + 'T00:00:00Z');
  const end = new Date(checkout + 'T00:00:00Z');
  while (current < end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

/**
 * roomConfig: [{ room_type, num_adults, num_children_above_6, num_children_below_6 }]
 * addonIds: array of addon ids (or indices, matching however your hotel.addons are keyed)
 */
async function calculatePrice(supabase, { hotelName, checkin, checkout, mealPlan, roomConfig, addonIds = [] }) {
  const { data: hotel, error } = await supabase
    .from('hotels')
    .select('rates, room_details, addons')
    .eq('name', hotelName)
    .single();

  if (error || !hotel) {
    throw new Error('Hotel not found: ' + hotelName);
  }

  const dates = getDatesBetween(checkin, checkout);
  if (dates.length === 0) {
    throw new Error('Invalid date range: checkout must be after checkin');
  }

  let roomCharges = 0;

  for (const room of roomConfig) {
    const roomDetail = hotel.room_details?.[room.room_type];
    if (!roomDetail) {
      throw new Error(`Unknown room type: ${room.room_type}`);
    }

    // Enforce capacity limits server-side too. The browser's occupancy
    // selector already does this, but it's not trustworthy on its own.
    const maxAdults = roomDetail.maxAdults ?? 4;
    const maxOccupants = roomDetail.maxOccupants ?? 5;
    const totalAdultEquiv = (room.num_adults || 0) + (room.num_children_above_6 || 0);
    const totalOccupants = totalAdultEquiv + (room.num_children_below_6 || 0);

    if (totalAdultEquiv > maxAdults) {
      throw new Error(`${room.room_type}: ${totalAdultEquiv} adult-equivalents exceeds max of ${maxAdults}`);
    }
    if (totalOccupants > maxOccupants) {
      throw new Error(`${room.room_type}: ${totalOccupants} guests exceeds max occupancy of ${maxOccupants}`);
    }
    if (!room.num_adults || room.num_adults < 1) {
      throw new Error(`${room.room_type}: at least 1 adult is required`);
    }

    for (const dateStr of dates) {
      const dayRates = hotel.rates?.[dateStr]?.[room.room_type];
      if (!dayRates) {
        throw new Error(`No rate configured for ${room.room_type} on ${dateStr}`);
      }

      let nightlyRate;
      if (totalAdultEquiv <= 1) {
        nightlyRate = dayRates[mealPlan === 'cp' ? 'single_cp' : 'single_ep'] || 0;
      } else if (totalAdultEquiv === 2) {
        nightlyRate = dayRates[mealPlan === 'cp' ? 'double_cp' : 'double_ep'] || 0;
      } else {
        const doubleRate = dayRates[mealPlan === 'cp' ? 'double_cp' : 'double_ep'] || 0;
        const extraAdultRate = dayRates.extra_adult || 0;
        nightlyRate = doubleRate + (totalAdultEquiv - 2) * extraAdultRate;
      }

      if (!nightlyRate || nightlyRate <= 0) {
        throw new Error(`No valid rate found for ${room.room_type} on ${dateStr}`);
      }
      roomCharges += nightlyRate;
    }
  }

  // Addons — look up prices from the DB by id, never accept a price from the client.
  let addonsCharges = 0;
  const addonDetails = [];
  if (addonIds.length > 0 && Array.isArray(hotel.addons)) {
    for (const id of addonIds) {
      const addon = hotel.addons.find(a => a.id === id) || hotel.addons[id];
      if (!addon) {
        throw new Error(`Unknown addon: ${id}`);
      }
      addonsCharges += addon.price || 0;
      addonDetails.push(addon);
    }
  }

  const taxableAmount = roomCharges + addonsCharges;
  const taxRate = roomCharges >= 7500 ? 0.18 : 0.05;
  const taxAmount = taxableAmount * taxRate;

  // Razorpay convenience fee: 2% commission (min ₹0.03) + 18% GST on the commission.
  const commission = Math.max(taxableAmount * 0.02, 0.03);
  const gstOnCommission = commission * 0.18;
  const convenienceFee = commission + gstOnCommission;

  const totalRupees = taxableAmount + taxAmount + convenienceFee;

  return {
    roomCharges,
    addonsCharges,
    addonDetails,
    taxRate,
    taxAmount,
    convenienceFee,
    totalRupees,
    totalPaise: Math.round(totalRupees * 100),
    nights: dates.length
  };
}

module.exports = { calculatePrice, getDatesBetween };
