const { sendTo24GolfApi, getAccessToken } = require('../utils/api');

// 보류 중인 모든 예약 업데이트 처리
const processPendingBookingUpdates = async (accessToken, maps) => {
  const { bookingDataMap, requestMap } = maps;
  
  console.log('[INFO] Processing any pending booking updates after getting booking data');
  
  // Find all pending booking updates
  for (const [key, data] of bookingDataMap.entries()) {
    if (key.startsWith('pendingUpdate_') && data.type === 'Booking_Update_Pending') {
      const bookId = key.replace('pendingUpdate_', '');
      console.log(`[INFO] Found pending update for book_id ${bookId}`);
      
      // Check if we have recent revenue updates for this book
      let revenueUpdated = false;
      for (const [revKey, revData] of requestMap.entries()) {
        if (revKey.startsWith('revenueUpdate_') && revData.bookId === bookId && 
            (Date.now() - revData.timestamp) < 60000) { // Only consider recent updates (last minute)
          revenueUpdated = true;
          break;
        }
      }
      
      // Process the booking update
      try {
        console.log(`[INFO] Processing pending booking update for book_id ${bookId}${revenueUpdated ? ' with updated revenue data' : ''}`);
        await processBookingUpdate(data.url, data.payload, accessToken, maps);
        // Remove from pending list
        bookingDataMap.delete(key);
      } catch (error) {
        console.error(`[ERROR] Failed to process pending booking update for ${bookId}: ${error.message}`);
      }
    }
  }
};

// Process a single booking update
const processBookingUpdate = async (url, payload, accessToken, maps) => {
  const { processedBookings, paymentAmounts, paymentStatus } = maps;
  const bookingId = payload.externalId;
  
  if (!bookingId) {
    console.error('[ERROR] Missing booking ID in payload');
    return;
  }
  
  console.log(`[INFO] Processing Booking_Update for book_id: ${bookingId}`);
  
  // 항상 맵에서 최신 결제 정보 사용
  const currentAmount = paymentAmounts.get(bookingId) || 0;
  const currentStatus = paymentStatus.get(bookingId) || false;
  
  console.log(`[INFO] Final payment values for book_id ${bookingId}: amount=${currentAmount}, finished=${currentStatus}`);
  
  // Make sure we have a token
  let currentToken = accessToken;
  if (!currentToken) {
    try {
      currentToken = await getAccessToken();
    } catch (error) {
      console.error(`[ERROR] Failed to refresh token for Booking_Update: ${error.message}`);
      return;
    }
  }
  
  // Send the update to the API
  await sendTo24GolfApi(
    'Booking_Update', 
    url, 
    payload, 
    null, 
    currentToken, 
    processedBookings, 
    paymentAmounts, 
    paymentStatus
  );
  
  console.log(`[INFO] Processed Booking_Update for book_id ${bookingId}`);
};

// book ID 찾기 (revenue ID 또는 book_idx로)
const findBookIdByRevenueIdOrBookIdx = (revenueId, bookIdx, maps) => {
  const { revenueToBookingMap, bookIdToIdxMap } = maps;
  
  // 먼저 revenue ID로 찾기
  let bookId = revenueToBookingMap.get(revenueId);
  if (bookId) {
    return bookId;
  }
  
  // 없으면 book_idx로 찾기
  if (bookIdx) {
    const entries = Array.from(bookIdToIdxMap.entries());
    const match = entries.find(([, idx]) => idx === bookIdx);
    if (match) {
      return match[0];  // book ID
    }
  }
  
  return null;
};

const extractRevenueId = (url) => {
  try {
    const match = url.match(/\/owner\/revenue\/(\d+)\//);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
  } catch (err) {
    console.error(`[ERROR] Failed to extract revenue ID from URL: ${url}`);
  }
  return null;
};

const handleBookingListingResponse = async (response, maps) => {
  const { paymentAmounts, paymentStatus, bookIdToIdxMap, revenueToBookingMap, requestMap } = maps;
  
  try {
    const responseBody = await response.json();
    console.log(`[DEBUG] /owner/booking/ response received, count: ${responseBody.count || 0}`);

    if (!responseBody.results || !Array.isArray(responseBody.results)) {
      console.log(`[WARN] Unexpected booking list response format:`, JSON.stringify(responseBody, null, 2));
      return;
    }

    // Process each booking in the response
    for (const booking of responseBody.results) {
      if (!booking.book_id) {
        console.log(`[WARN] Booking without book_id in response`);
        continue;
      }

      const bookId = booking.book_id;
      const bookIdx = booking.idx?.toString() || '';
      const revenueId = booking.revenue;
      
      // Extract revenue detail information
      const revenueDetail = booking.revenue_detail || {};
      const amount = revenueDetail.amount || booking.amount || 0;
      const finished = revenueDetail.finished === true || 
                      revenueDetail.finished === 'true' || 
                      booking.immediate_booked === true || 
                      booking.confirmed_by === 'IM';

      // Store mappings
      revenueToBookingMap.set(revenueId, bookId);
      bookIdToIdxMap.set(bookId, bookIdx);
      
      // Check if we have any pending revenue updates for this revenue ID
      const tmpRevenueKey = `revenueUpdate_${revenueId}`;
      const pendingRevenue = requestMap.get(tmpRevenueKey);
      
      if (pendingRevenue) {
        console.log(`[INFO] Found pending revenue update for book_id ${bookId} (revenue ID ${revenueId}): amount=${pendingRevenue.amount}, finished=${pendingRevenue.finished}`);
        
        // Use the more recent data from the PATCH request
        paymentAmounts.set(bookId, pendingRevenue.amount);
        paymentStatus.set(bookId, pendingRevenue.finished);
        
        // Clean up temporary data
        requestMap.delete(tmpRevenueKey);
      } else {
        // Use the data from the booking listing
        paymentAmounts.set(bookId, parseInt(amount, 10) || 0);
        paymentStatus.set(bookId, finished);
      }

      console.log(`[INFO] Mapped revenue ${revenueId} to book_id ${bookId}, amount: ${paymentAmounts.get(bookId)}, finished: ${paymentStatus.get(bookId)}, idx: ${bookIdx}`);
    }
  } catch (e) {
    console.error(`[ERROR] Failed to parse /owner/booking/ response: ${e.message}`);
  }
};

const handleRevenueResponse = async (response, request, maps) => {
  const { paymentAmounts, paymentStatus, bookIdToIdxMap } = maps;
  const { parseMultipartFormData } = require('../utils/parser');
  
  try {
    const responseData = await response.json();
    let payload;
    
    try {
      payload = parseMultipartFormData(request.postData());
    } catch (e) {
      console.error(`[ERROR] Failed to parse revenue request data: ${e.message}`);
      return null;
    }
    
    if (!payload || !payload.book_idx) {
      console.log(`[WARN] Missing book_idx in revenue payload:`, JSON.stringify(payload, null, 2));
      return null;
    }

    const bookIdx = payload.book_idx;
    const amount = parseInt(payload.amount, 10) || 0;
    
    // 중요: string 'true'/'false'를 실제 boolean으로 변환
    const finishedStr = payload.finished?.toLowerCase() || 'false';
    const finished = finishedStr === 'true';
    
    console.log(`[DEBUG] Payment status in revenue payload: '${payload.finished}' -> ${finished}`);

    // Find the book_id using the book_idx
    const bookIdEntries = Array.from(bookIdToIdxMap.entries());
    const match = bookIdEntries.find(([, idx]) => idx === bookIdx);
    const bookId = match ? match[0] : null;

    if (bookId) {
      paymentAmounts.set(bookId, amount);
      paymentStatus.set(bookId, finished);
      console.log(`[INFO] Updated payment for book_id ${bookId} (book_idx ${bookIdx}): amount=${amount}, finished=${finished}`);
      return { bookId, amount, finished };
    } else {
      console.log(`[WARN] No book_id found for book_idx ${bookIdx}`);
    }
  } catch (e) {
    console.error(`[ERROR] Failed to parse /owner/revenue/ response: ${e.message}`);
  }
  
  return null;
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

    // 결제 정보 확인 (이미 결제 정보가 있는지)
    const paymentAmount = paymentAmounts.get(bookId) || 0;
    const isPaymentCompleted = paymentStatus.get(bookId) || false;
    
    // 결제 정보가 이미 있으면 바로 API 호출
    if (paymentAmount > 0) {
      console.log(`[INFO] Payment information already available for book_id ${bookId}: amount=${paymentAmount}, completed=${isPaymentCompleted}`);
      
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
      
      console.log(`[INFO] Processed Booking_Create for book_id ${bookId} with payment info`);
      bookingDataMap.delete(bookId);
    } else {
      // 결제 정보가 없으면 Pending 상태로 저장하고 결제 정보 업데이트 기다림
      console.log(`[INFO] Waiting for payment information for book_id ${bookId}`);
      
      // 예약 생성 요청을 Pending 상태로 저장
      bookingDataMap.set(bookId, { 
        type: 'Booking_Create_Pending', 
        url,
        payload: requestData.payload, 
        response: responseData, 
        timestamp: Date.now() 
      });
      
      // 최대 10초 기다린 후 결제 정보 유무 확인하여 API 호출
      setTimeout(async () => {
        const pendingBooking = bookingDataMap.get(bookId);
        if (pendingBooking && pendingBooking.type === 'Booking_Create_Pending') {
          const currentPaymentAmount = paymentAmounts.get(bookId) || 0;
          const currentPaymentStatus = paymentStatus.get(bookId) || false;
          
          console.log(`[INFO] After waiting, payment info for book_id ${bookId}: amount=${currentPaymentAmount}, completed=${currentPaymentStatus}`);
          
          // 토큰 확인 및 갱신
          let currentToken = accessToken;
          if (!currentToken) {
            try {
              currentToken = await getAccessToken();
            } catch (err) {
              console.error(`[ERROR] Failed to get token after waiting: ${err.message}`);
              return;
            }
          }
          
          // 최종적으로 API 호출 실행 (결제 정보가 있든 없든)
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
          
          console.log(`[INFO] Processed Booking_Create for book_id ${bookId} after waiting`);
          bookingDataMap.delete(bookId);
        }
      }, 10000); // 10초 대기
    }
    
    // Clean up request map entry
    requestMap.delete(url);
  } catch (e) {
    console.error(`[ERROR] Failed to process Booking_Create: ${e.message}`);
  }
};

module.exports = {
  processPendingBookingUpdates,
  processBookingUpdate,
  findBookIdByRevenueIdOrBookIdx,
  extractRevenueId,
  handleBookingListingResponse,
  handleRevenueResponse,
  handleBookingCreateResponse
};