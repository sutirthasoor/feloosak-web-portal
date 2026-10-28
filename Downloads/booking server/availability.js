// availability.js
const { getDatesBetween } = require('./pricing');

/**
 * Checks that enough rooms of each requested type are free for every
 * night of the stay. Recomputed from the DB — never trusts the client.
 */
async function checkAvailability(supabase, hotelName, checkin, checkout, roomConfig) {
  const { data: hotel, error } = await supabase
    .from('hotels')
    .select('inventory')
    .eq('name', hotelName)
    .single();

  if (error || !hotel?.inventory) return false;

  const dates = getDatesBetween(checkin, checkout);

  const neededByType = {};
  roomConfig.forEach(r => {
    neededByType[r.room_type] = (neededByType[r.room_type] || 0) + 1;
  });

  for (const [roomType, needed] of Object.entries(neededByType)) {
    for (const date of dates) {
      const avail = hotel.inventory[date]?.[roomType] || 0;
      if (avail < needed) return false;
    }
  }
  return true;
}

/**
 * Deducts booked rooms from inventory. Called only after a payment has
 * been verified (from the webhook), never from client-reported success.
 */
async function deductInventory(supabase, hotelName, checkin, checkout, roomConfig) {
  const { data: hotel, error } = await supabase
    .from('hotels')
    .select('id, inventory')
    .eq('name', hotelName)
    .single();

  if (error || !hotel?.inventory) {
    throw new Error('Could not load inventory for deduction');
  }

  const dates = getDatesBetween(checkin, checkout);
  const updatedInventory = JSON.parse(JSON.stringify(hotel.inventory));

  const neededByType = {};
  roomConfig.forEach(r => {
    neededByType[r.room_type] = (neededByType[r.room_type] || 0) + 1;
  });

  for (const [roomType, needed] of Object.entries(neededByType)) {
    for (const date of dates) {
      const current = updatedInventory[date]?.[roomType] || 0;
      if (current < needed) {
        throw new Error(`Inventory conflict: ${roomType} on ${date} has only ${current} left, needed ${needed}`);
      }
      updatedInventory[date][roomType] = current - needed;
    }
  }

  const { error: updateError } = await supabase
    .from('hotels')
    .update({ inventory: updatedInventory })
    .eq('id', hotel.id);

  if (updateError) throw updateError;
}

module.exports = { checkAvailability, deductInventory };
