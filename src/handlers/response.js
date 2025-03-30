const { sendTo24GolfApi, getAccessToken } = require('../utils/api');
const { parseMultipartFormData } = require('../utils/parser');

const setupResponseHandler = (page, accessToken, maps) => {
  const { requestMap, processedBookings, paymentAmounts, paymentStatus, bookIdToIdxMap, revenueToBookingMap, bookingDataMap } = maps;

  page.on('response', async (response) => {
    const url = response.url();
    const status = response.status();
    const request = response.request();
    const method = request.method();

    console.log(`[DEBUG] Response captured - URL: ${url}, Status: ${status}, Method: ${method}`);

    // Skip non-successful responses and non-API calls
    if (!url.includes('api.kimcaddie.com/api/') || status >= 400) {
      return;
    }

    try {
      // /owner/booking/ GET 응답 처리 (Getting existing bookings and payment info)
      if (url.includes('/owner/booking/') && method === 'GET' && status === 200) {
        await handleBookingListingResponse(response, maps);
      }

      // /owner/revenue/ POST 응답 처리 (Payment registration)
      else if (url.includes('/owner/revenue/') && method === 'POST' && status === 200) {
        await handleRevenueResponse(response, request, maps);
      }

      // /owner/booking POST 응답 처리 (Booking_Create)
      else if (url.includes('/owner/booking') && method === 'POST' && (status === 200 || status === 201)) {
        await handleBookingCreateResponse(url, response, requestMap, accessToken, maps);
      }
    } catch (error) {
      console.error(`[ERROR] Error handling response for ${url}: ${error.message}`);
    }
  });
};

const handleBookingListingResponse = async (response, maps) => {
  const { paymentAmounts, paymentStatus, bookIdToIdxMap, revenueToBookingMap } = maps;
  
  try {
    const responseBody = await response.json();
    console.log(`[DEBUG] /owner/booking/ response received, count: ${responseBody.count || 0}`);

    if (!responseBody.results || !Array.isArray(responseBody.results)) {
      console.log(`[WARN] Unexpected booking list response format:`, JSON.stringify(responseBody, null, 2));
      return;
    }

    responseBody.results.forEach((booking) => {
      if (!booking.book_id) {
        console.log(`[WARN] Booking without book_id in response:`, JSON.stringify(booking, null, 2));
        return;
      }

      const bookId = booking.book_id;
      const revenueId = booking.revenue;
      const amount = booking.revenue_detail?.amount || 0;
      const finished = booking.revenue_detail?.finished || false;

      revenueToBookingMap.set(revenueId, bookId);
      paymentAmounts.set(bookId, amount);
      paymentStatus.set(bookId, finished);
      bookIdToIdxMap.set(bookId, booking.idx?.toString() || '');

      console.log(`[INFO] Mapped revenue ${revenueId} to book_id ${bookId}, amount: ${amount}, finished: ${finished}, idx: ${booking.idx}`);
    });
  } catch (e) {
    console.error(`[ERROR] Failed to parse /owner/booking/ response: ${e.message}`);
  }
};

const handleRevenueResponse = async (response, request, maps) => {
  const { paymentAmounts, paymentStatus, bookIdToIdxMap } = maps;
  
  try {
    const responseData = await response.json();
    let payload;
    
    try {
      payload = parseMultipartFormData(request.postData());
    } catch (e) {
      console.error(`[ERROR] Failed to parse revenue request data: ${e.message}`);
      return;
    }
    
    if (!payload || !payload.book_idx) {
      console.log(`[WARN] Missing book_idx in revenue payload:`, JSON.stringify(payload, null, 2));
      return;
    }

    const bookIdx = payload.book_idx;
    const amount = parseInt(payload.amount, 10) || 0;
    const finished = responseData.finished || payload.finished === 'true';

    // Find the book_id using the book_idx
    const bookIdEntries = Array.from(bookIdToIdxMap.entries());
    const match = bookIdEntries.find(([, idx]) => idx === bookIdx);
    const bookId = match ? match[0] : null;

    if (bookId) {
      paymentAmounts.set(bookId, amount);
      paymentStatus.set(bookId, finished);
      console.log(`[INFO] Updated payment for book_id ${bookId} (book_idx ${bookIdx}): amount=${amount}, finished=${finished}`);
    } else {
      console.log(`[WARN] No book_id found for book_idx ${bookIdx}`);
    }
  } catch (e) {
    console.error(`[ERROR] Failed to parse /owner/revenue/ response: ${e.message}`);
  }
};

const handleBookingCreateResponse = async (url, response, requestMap, accessToken, maps) => {
  const { processedBookings, paymentAmounts, paymentStatus, bookIdToIdxMap, bookingDataMap } = maps;
  
  try {
    let responseData;
    try {
      responseData = await response.json();
    } catch (e) {
      console.error(`[ERROR] Failed to parse booking create response: ${e.message}`);
      return;
    }
    
    console.log(`[DEBUG] Booking_Create Response Data:`, JSON.stringify(responseData, null, 2));
    
    if (!responseData || !responseData.book_id) {
      console.log(`[WARN] Missing book_id in booking create response:`, JSON.stringify(responseData, null, 2));
      return;
    }

    let requestData = requestMap.get(url);
    if (!requestData) {
      console.log(`[WARN] No matching request data found for URL: ${url}`);
      // We still want to process the booking, so create a minimal request data object
      requestData = { type: 'Booking_Create', payload: {} };
    }

    const bookId = responseData.book_id;
    bookIdToIdxMap.set(bookId, responseData.idx?.toString() || '');
    
    // Store the booking data with timestamp
    bookingDataMap.set(bookId, { 
      type: 'Booking_Create', 
      payload: requestData.payload, 
      response: responseData, 
      timestamp: Date.now() 
    });

    console.log(`[INFO] Booking_Create stored for book_id ${bookId}, idx: ${responseData.idx}`);

    // Check for a valid token
    let currentToken = accessToken;
    if (!currentToken) {
      try {
        currentToken = await getAccessToken();
        console.log(`[INFO] Got new token for Booking_Create API call`);
      } catch (tokenError) {
        console.error(`[ERROR] Failed to get token for Booking_Create: ${tokenError.message}`);
        return;
      }
    }

    // Send booking data to 24Golf API
    await sendTo24GolfApi(
      'Booking_Create',
      url,
      requestData.payload,
      responseData,
      currentToken,
      processedBookings,
      paymentAmounts,
      paymentStatus
    );
    
    console.log(`[INFO] Processed Booking_Create for book_id ${bookId}`);
    
    // Clean up after successful processing
    bookingDataMap.delete(bookId);
    requestMap.delete(url);
  } catch (e) {
    console.error(`[ERROR] Failed to process Booking_Create: ${e.message}`);
  }
};

module.exports = { setupResponseHandler };