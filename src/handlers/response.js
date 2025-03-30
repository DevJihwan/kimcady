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

      // /owner/revenue/ PATCH 응답 처리 (Payment update)
      else if (url.includes('/owner/revenue/') && method === 'PATCH' && status === 200) {
        const revenueId = extractRevenueId(url);
        if (revenueId) {
          console.log(`[DEBUG] Processing revenue update for revenue ID: ${revenueId}`);
          const patchPayload = parseMultipartFormData(request.postData());
          
          // Store temporary revenue data for later use when booking data is received
          if (patchPayload && patchPayload.book_idx && patchPayload.amount) {
            const tmpData = {
              revenueId,
              bookIdx: patchPayload.book_idx,
              amount: parseInt(patchPayload.amount, 10) || 0,
              finished: patchPayload.finished === 'true',
              timestamp: Date.now()
            };
            
            // 이미 book_id를 알고 있는 경우 즉시 결제 정보 업데이트
            const bookId = findBookIdByRevenueIdOrBookIdx(revenueId, patchPayload.book_idx, maps);
            if (bookId) {
              console.log(`[INFO] Found book_id ${bookId} for revenue ID ${revenueId} (or book_idx ${patchPayload.book_idx})`);
              paymentAmounts.set(bookId, tmpData.amount);
              paymentStatus.set(bookId, tmpData.finished);
              console.log(`[INFO] Updated payment for book_id ${bookId}: amount=${tmpData.amount}, finished=${tmpData.finished}`);
            } else {
              // Store this data temporarily to use after we get booking data
              console.log(`[DEBUG] Storing revenue update data for revenue ID ${revenueId}, bookIdx ${patchPayload.book_idx}: amount=${tmpData.amount}, finished=${tmpData.finished}`);
              requestMap.set(`tmp_revenue_${revenueId}`, tmpData);
            }
          }
        }
      }

      // /owner/revenue/ POST 응답 처리 (Payment registration)
      else if (url.includes('/owner/revenue/') && method === 'POST' && status === 200) {
        const revenueData = await handleRevenueResponse(response, request, maps);
        
        // 결제 정보가 업데이트된 후 pending 상태의 예약 처리가 있으면 다시 시도
        if (revenueData && revenueData.bookId) {
          const pendingBooking = bookingDataMap.get(revenueData.bookId);
          if (pendingBooking && pendingBooking.type === 'Booking_Create_Pending') {
            console.log(`[INFO] Processing pending Booking_Create for book_id ${revenueData.bookId} after payment update`);
            
            // 토큰 확인 및 갱신
            let currentToken = accessToken;
            if (!currentToken) {
              try {
                currentToken = await getAccessToken();
              } catch (err) {
                console.error(`[ERROR] Failed to get token for pending Booking_Create: ${err.message}`);
                return;
              }
            }
            
            // 결제 정보가 포함된 API 호출 실행
            await sendTo24GolfApi(
              'Booking_Create',
              pendingBooking.url,
              pendingBooking.payload,
              pendingBooking.response,
              currentToken,
              processedBookings,
              paymentAmounts,
              paymentStatus
            );
            
            console.log(`[INFO] Processed pending Booking_Create with payment info for book_id ${revenueData.bookId}`);
            bookingDataMap.delete(revenueData.bookId);
          }
        }
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
      const amount = revenueDetail.amount || 0;
      const finished = revenueDetail.finished || false;

      // Store mappings
      revenueToBookingMap.set(revenueId, bookId);
      bookIdToIdxMap.set(bookId, bookIdx);
      
      // Check if we have any pending revenue updates for this revenue ID
      const tmpRevenueKey = `tmp_revenue_${revenueId}`;
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
        paymentAmounts.set(bookId, amount);
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

module.exports = { setupResponseHandler };