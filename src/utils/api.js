const axios = require('axios');
const { STORE_ID } = require('../config/env');

const getAccessToken = async () => {
  const url = `https://api.dev.24golf.co.kr/auth/token/stores/${STORE_ID}/role/singleCrawler`;
  console.log(`[Token] Attempting to fetch access token from: ${url}`);

  try {
    const response = await axios.get(url, { 
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000 // 10 seconds timeout
    });
    
    if (!response.data) {
      throw new Error('Empty token response received');
    }
    
    const accessToken = response.data;
    console.log('[Token] Successfully obtained access token:', accessToken);
    return accessToken;
  } catch (error) {
    console.error('[Token Error] Failed to obtain access token:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
    throw error;
  }
};

const sendTo24GolfApi = async (type, url, payload, response, accessToken, processedBookings = new Set(), paymentAmounts = new Map(), paymentStatus = new Map()) => {
  if (!accessToken) {
    console.error(`[API Error] Cannot send ${type}: Missing access token`);
    try {
      accessToken = await getAccessToken();
    } catch (e) {
      console.error(`[API Error] Failed to refresh token: ${e.message}`);
      return;
    }
  }

  const bookId = response?.book_id || payload?.externalId || 'unknown';
  if (type === 'Booking_Create' && processedBookings.has(bookId)) {
    console.log(`[INFO] Skipping duplicate Booking_Create for book_id: ${bookId}`);
    return;
  }

  // 결제 정보 로깅 및 확인
  const paymentAmount = paymentAmounts.get(bookId) || 0;
  const isPaymentCompleted = paymentStatus.get(bookId) || false;
  
  console.log(`[DEBUG] Payment info for ${bookId} - Amount: ${paymentAmount}, Completed: ${isPaymentCompleted}`);

  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${type} - URL: ${url} - Payload:`, JSON.stringify(payload, null, 2));
  console.log(`[DEBUG] API Data Prep - bookId: ${bookId}, paymentAmount: ${paymentAmount}, isPaymentCompleted: ${isPaymentCompleted}`);

  const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  let apiMethod, apiUrl, apiData;
  if (type === 'Booking_Create' && response) {
    apiMethod = 'POST';
    apiUrl = `https://api.dev.24golf.co.kr/stores/${STORE_ID}/reservation/crawl`;
    apiData = {
      externalId: bookId,
      name: response.name || payload?.name || 'Unknown',
      phone: response.phone || payload?.phone || '010-0000-0000',
      partySize: parseInt(response.person || payload?.person || 1, 10),
      startDate: response.start_datetime || `${payload?.book_date}T${payload?.book_time || '00:00:00'}+09:00`,
      endDate: response.end_datetime || calculateEndTime(response.start_datetime || `${payload?.book_date}T${payload?.book_time || '00:00:00'}+09:00`),
      roomId: (response.room || payload?.room || payload?.room_id || 'unknown').toString(),
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
      endDate: payload.end_datetime || calculateEndTime(payload.start_datetime),
      roomId: payload.room_id || payload.room || 'unknown',
      paymented: isPaymentCompleted,
      paymentAmount,
      crawlingSite: 'KimCaddie',
    };
  } else if (type === 'Booking_Cancel') {
    apiMethod = 'DELETE';
    apiUrl = `https://api.dev.24golf.co.kr/stores/${STORE_ID}/reservation/crawl`;
    apiData = { 
      externalId: bookId, 
      crawlingSite: 'KimCaddie', 
      reason: payload.canceled_by || 'Canceled by Manager' 
    };
  } else {
    console.log(`[WARN] Unknown type: ${type}, skipping API call`);
    return;
  }

  // Double-check payment info before sending
  if ((type === 'Booking_Create' || type === 'Booking_Update') && apiData) {
    // Ensure we're using the latest payment info
    const latestPaymentAmount = paymentAmounts.get(bookId);
    const latestPaymentStatus = paymentStatus.get(bookId);
    
    if (latestPaymentAmount !== undefined) {
      apiData.paymentAmount = latestPaymentAmount;
    }
    
    if (latestPaymentStatus !== undefined) {
      apiData.paymented = latestPaymentStatus;
    }
    
    // Log final data being sent
    console.log(`[DEBUG] Final payment values for ${bookId}: Amount=${apiData.paymentAmount}, Completed=${apiData.paymented}`);
  }

  console.log(`[DEBUG] ${type} API data:`, JSON.stringify(apiData, null, 2));

  try {
    console.log(`[API Request] Sending ${type} to ${apiUrl}`);
    let apiResponse;
    
    if (apiMethod === 'DELETE') {
      apiResponse = await axios.delete(apiUrl, { 
        headers, 
        data: apiData,
        timeout: 10000
      });
    } else {
      apiResponse = await axios({ 
        method: apiMethod, 
        url: apiUrl, 
        headers, 
        data: apiData,
        timeout: 10000
      });
    }
    
    console.log(`[API] Successfully sent ${type}: ${apiResponse.status}`);
    console.log(`[API] Response data:`, JSON.stringify(apiResponse.data, null, 2));
    
    if (type === 'Booking_Create') {
      processedBookings.add(bookId);
    }
    
    return apiResponse.data;
  } catch (error) {
    console.error(`[API Error] Failed to send ${type}: ${error.message}`);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
    
    // Token might be expired, try to refresh once
    if (error.response && error.response.status === 401) {
      console.log('[API] Token might be expired, attempting to refresh...');
      try {
        const newToken = await getAccessToken();
        // Retry the request with the new token
        return sendTo24GolfApi(type, url, payload, response, newToken, processedBookings, paymentAmounts, paymentStatus);
      } catch (tokenError) {
        console.error(`[API Error] Failed to refresh token: ${tokenError.message}`);
      }
    }
  }
};

// Helper function to calculate end time (1 hour after start time)
const calculateEndTime = (startTime) => {
  if (!startTime) return new Date().toISOString().replace('Z', '+09:00');
  
  try {
    const date = new Date(startTime);
    date.setHours(date.getHours() + 1);
    return date.toISOString().replace('Z', '+09:00');
  } catch (e) {
    console.error(`[ERROR] Failed to calculate end time from: ${startTime}`);
    return new Date().toISOString().replace('Z', '+09:00');
  }
};

module.exports = { getAccessToken, sendTo24GolfApi };