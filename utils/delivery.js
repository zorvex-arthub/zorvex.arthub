/**
 * DELIVERY FEE CALCULATOR
 * Placeholder for Shiprocket / India Post integration.
 * Currently uses pincode zone-based estimation.
 * Replace internals with Shiprocket API call when credentials are ready.
 */

// Kerala pincodes: 670001 – 695615
const isKerala = (pin) => {
  const p = parseInt(pin);
  return p >= 670001 && p <= 695615;
};

/**
 * calculateDeliveryFee(buyerPincode, artistPincode)
 * Returns an estimated shipping cost in INR.
 */
exports.calculateDeliveryFee = async (buyerPincode, artistPincode) => {
  // Validate pincodes
  if (!buyerPincode || !artistPincode) {
    return { fee: 60, zone: 'standard', note: 'Default rate (pincode missing)' };
  }

  const buyerPin  = String(buyerPincode).trim();
  const artistPin = String(artistPincode).trim();

  if (buyerPin.length !== 6 || artistPin.length !== 6) {
    return { fee: 60, zone: 'standard', note: 'Default rate (invalid pincode)' };
  }

  // Same pincode — hyperlocal
  if (buyerPin === artistPin) {
    return { fee: 30, zone: 'hyperlocal', note: 'Same area delivery' };
  }

  // Both in Kerala
  const buyerKerala  = isKerala(buyerPin);
  const artistKerala = isKerala(artistPin);

  if (buyerKerala && artistKerala) {
    // Same district (first 4 digits match)
    if (buyerPin.slice(0, 4) === artistPin.slice(0, 4)) {
      return { fee: 40, zone: 'intra-district', note: 'Within district' };
    }
    return { fee: 60, zone: 'intra-state', note: 'Within Kerala' };
  }

  // One in Kerala, one outside
  if (buyerKerala || artistKerala) {
    return { fee: 100, zone: 'inter-state', note: 'South India delivery' };
  }

  // Both outside Kerala
  return { fee: 150, zone: 'national', note: 'Pan-India delivery' };

  // ─── TODO: Replace above with Shiprocket API ───
  // const response = await axios.post('https://apiv2.shiprocket.in/v1/external/courier/serviceability/', {
  //   pickup_postcode: artistPincode,
  //   delivery_postcode: buyerPincode,
  //   weight: 0.5,
  //   cod: 0
  // }, { headers: { Authorization: `Bearer ${shiprocketToken}` } });
  // return response.data;
};

/**
 * Validate a 6-digit Indian pincode (basic check)
 */
exports.isValidPincode = (pin) => /^\d{6}$/.test(String(pin));
