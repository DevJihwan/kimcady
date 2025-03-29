const axios = require('axios');
const { STORE_ID } = require('../config/env');

const getAccessToken = async () => {
  const url = `https://api.dev.24golf.co.kr/auth/token/stores/${STORE_ID}/role/singleCrawler`;
  console.log(`[Token] Attempting to fetch access token from: ${url}`);

  try {
    const response = await axios.get(url, { headers: { 'Content-Type': 'application/json' } });
    const accessToken = response.data;
    console.log('[Token] Successfully obtained access token:', accessToken);
    return accessToken;
  } catch (error) {
    console.error('[Token Error] Failed to obtain access token:', error.message);
    throw error;
  }
};

const sendTo24GolfApi = async (type, url, payload, response, accessToken, processedBookings = new Set(), paymentAmounts = new Map(), paymentStatus = new Map()) => {
  const bookId = response?.book_id || payload?.externalId || 'unknown';
  if (type === 'Booking_Create' && processedBookings.has(bookId)) {
    console.log(`[INFO] Skipping duplicate Booking_Create for book_id: ${bookId}`);
    return;
  }

  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${type} - URL: ${url} - Payload:`, JSON.stringify(payload, null, 2));

  const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const paymentAmount = paymentAmounts.get(bookId) || 0;
  const isPaymentCompleted = paymentStatus.get(bookId) || false;

  console.log(`[DEBUG] API Data Prep - bookId: ${bookId}, paymentAmount: ${paymentAmount}, isPaymentCompleted: ${isPaymentCompleted}`);

  let apiMethod, apiUrl, apiData;
  if (type === 'Booking_Create' && response) {
    apiMethod = 'POST';
    apiUrl = `https://api.dev.24golf.co.kr/stores/${STORE_ID}/reservation/crawl`;
    apiData = {
      externalId: bookId,
      name: response.name || 'Unknown',
      phone: response.phone || '010-0000-0000',
      partySize: parseInt(response.person || payload.person || 1, 10),
      startDate: response.start_datetime || `${payload.book_date}T${payload.book_time || '00:00:00'}+09:00`,
      endDate: response.end_datetime || new Date(new Date(response.start_datetime).getTime() + 3600000).toISOString().replace('Z', '+09:00'),
      roomId: (response.room || payload.room || 'unknown').toString(),
      paymented: isPaymentCompleted,
      paymentAmount,
      crawlingSite: 'KimCaddie',
    };
  } else if (type === 'Booking_Update') {
    apiMethod = 'PATCH';
    apiUrl = `https://api.dev.24golf.co.kr/stores/${STORE_ID}/reservation/crawl`;
    apiData = {
      externalId: bookId,
      name: payload.name || 'Unknown',
      phone: payload.phone || '010-0000-0000',
      partySize: parseInt(payload.person || 1, 10),
      startDate: payload.start_datetime || new Date().toISOString().replace('Z', '+09:00'),
      endDate: payload.end_datetime || new Date(new Date(payload.start_datetime).getTime() + 3600000).toISOString().replace('Z', '+09:00'),
      roomId: payload.room_id || payload.room || 'unknown',
      paymented: isPaymentCompleted,
      paymentAmount,
      crawlingSite: 'KimCaddie',
    };
  } else if (type === 'Booking_Cancel') {
    apiMethod = 'DELETE';
    apiUrl = `https://api.dev.24golf.co.kr/stores/${STORE_ID}/reservation/crawl`;
    apiData = { externalId: bookId, crawlingSite: 'KimCaddie', reason: payload.canceled_by || 'Canceled by Manager' };
  }

  console.log(`[DEBUG] ${type} API data:`, JSON.stringify(apiData, null, 2));

  try {
    console.log(`[API Request] Sending ${type} to ${apiUrl}`);
    const apiResponse = apiMethod === 'DELETE'
      ? await axios.delete(apiUrl, { headers, data: apiData })
      : await axios({ method: apiMethod, url: apiUrl, headers, data: apiData });
    console.log(`[API] Successfully sent ${type}: ${apiResponse.status}`);
    if (type === 'Booking_Create') processedBookings.add(bookId);
  } catch (error) {
    console.error(`[API Error] Failed to send ${type}: ${error.message}`, error.response?.data || '');
  }
};

module.exports = { getAccessToken, sendTo24GolfApi };