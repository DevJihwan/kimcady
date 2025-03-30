const { sendTo24GolfApi, getAccessToken } = require('../utils/api');
const { parseMultipartFormData } = require('../utils/parser');

const setupResponseHandler = (page, accessToken, maps) => {
  const { requestMap, processedBookings, paymentAmounts, paymentStatus, bookIdToIdxMap, revenueToBookingMap, bookingDataMap } = maps;
  
  // 새로운 맵 추가 - 앱 예약 처리용
  const customerUpdates = new Map(); // 최근 고객 정보 업데이트 저장
  const processedAppBookings = new Set(); // 처리된 앱 예약 ID 저장

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
      // 고객 정보 API (앱 예약 감지)
      if (url.includes('/api/owner/customer/') && method === 'GET' && status === 200) {
        await handleCustomerResponse(response, customerUpdates);
      }
      
      // /owner/booking/ GET 응답 처리 (Getting existing bookings and payment info)
      else if (url.includes('/owner/booking/') && method === 'GET' && status === 200) {
        await handleBookingListingResponse(response, maps);
        
        // 앱 예약 처리 시도 (최근 업데이트된 고객 정보 기반)
        await processAppBookings(response, accessToken, maps, customerUpdates, processedAppBookings);
        
        // After processing booking listing, we need to process any pending booking updates
        await processPendingBookingUpdates(accessToken, maps);
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
              requestMap.set(`revenueUpdate_${revenueId}`, tmpData);
            }
          }
        }
      }

      // /owner/revenue/ POST 응답 처리 (Payment registration)
      else if (url.includes('/owner/revenue/') && method === 'POST' && status === 200) {
        const revenueData = await handleRevenueResponse(response, request, maps);
        
        // 결제 정보가 업데이트된 후 pending 상태의 예약 처리가 있으면 다시 시도
        if (revenueData && revenueData.bookId) {
          const pendingBooking = bookingDataMap.get(`pendingUpdate_${revenueData.bookId}`);
          if (pendingBooking && pendingBooking.type === 'Booking_Update_Pending') {
            console.log(`[INFO] Processing pending Booking_Update for book_id ${revenueData.bookId} after payment update`);
            await processBookingUpdate(pendingBooking.url, pendingBooking.payload, accessToken, maps);
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

// 고객 정보 응답 처리 (앱 예약 감지용)
const handleCustomerResponse = async (response, customerUpdates) => {
  try {
    const customerData = await response.json();
    
    if (!customerData || !customerData.id) {
      console.log(`[WARN] Invalid customer data response format`);
      return;
    }
    
    const customerId = customerData.id;
    const customerName = customerData.name || '';
    const customerPhone = customerData.phone || '';
    
    // 고객 정보 중 최근 업데이트 정보 확인
    let latestUpdateTime = null;
    
    if (customerData.customerinfo_set && Array.isArray(customerData.customerinfo_set) && customerData.customerinfo_set.length > 0) {
      const customerInfo = customerData.customerinfo_set[0];
      if (customerInfo.upd_date) {
        latestUpdateTime = new Date(customerInfo.upd_date).getTime();
      }
    }
    
    console.log(`[INFO] Detected customer info access - customerId: ${customerId}, name: ${customerName}, updateTime: ${latestUpdateTime}`);
    
    // 현재 시간 기준으로 최근 업데이트된 고객 정보만 저장 (30초 이내)
    const now = Date.now();
    const thirtySecondsAgo = now - 30 * 1000;
    
    if (latestUpdateTime && latestUpdateTime > thirtySecondsAgo) {
      console.log(`[INFO] Storing recent customer update for customerId: ${customerId}`);
      customerUpdates.set(customerId, {
        id: customerId,
        name: customerName,
        phone: customerPhone,
        updateTime: latestUpdateTime,
        timestamp: now
      });
    }
  } catch (e) {
    console.error(`[ERROR] Failed to parse customer response: ${e.message}`);
  }
};

// 앱 예약 처리 (예약 목록 조회 후)
const processAppBookings = async (response, accessToken, maps, customerUpdates, processedAppBookings) => {
  const { processedBookings, paymentAmounts, paymentStatus } = maps;
  
  try {
    // 예약 목록 파싱
    const bookingData = await response.json();
    if (!bookingData.results || !Array.isArray(bookingData.results)) {
      return;
    }
    
    console.log(`[INFO] Checking for app bookings in booking list...`);
    
    // 최근 고객 업데이트와 매칭되는 예약 찾기
    for (const booking of bookingData.results) {
      if (!booking.book_id || !booking.customer) {
        continue;
      }
      
      const bookId = booking.book_id;
      const customerId = booking.customer;
      const customerUpdate = customerUpdates.get(customerId);
      
      // 이미 처리된 예약은 건너뜀
      if (processedBookings.has(bookId) || processedAppBookings.has(bookId)) {
        continue;
      }
      
      // 앱 예약만 찾기 (book_type이 'U'이고 customer 필드가 있는 경우)
      const isAppBooking = booking.book_type === 'U' || booking.confirmed_by === 'IM' || booking.immediate_booked === true;
      
      if (isAppBooking) {
        // 최근 고객 업데이트가 있거나, 일반 앱 예약인 경우
        const isRecentUpdate = customerUpdate && (Date.now() - customerUpdate.timestamp < 60 * 1000); // 1분 이내
        const isCanceled = booking.state === 'canceled';
        
        // 새 예약 또는 취소된 예약 처리
        if (isRecentUpdate || booking.immediate_booked === true || isCanceled) {
          console.log(`[INFO] Detected ${isCanceled ? 'canceled' : (booking.immediate_booked ? 'immediate' : 'regular')} app booking: bookId=${bookId}, customerId=${customerId}, state=${booking.state}`);
          
          // 결제 정보 가져오기
          const revenueDetail = booking.revenue_detail || {};
          const amount = revenueDetail.amount || 0;
          const finished = revenueDetail.finished || false;
          
          // 맵에 저장
          paymentAmounts.set(bookId, amount);
          paymentStatus.set(bookId, finished);
          
          if (isCanceled) {
            // 취소된 예약 처리
            try {
              // Make sure we have a valid token
              let currentToken = accessToken;
              if (!currentToken) {
                currentToken = await getAccessToken();
              }
              
              console.log(`[INFO] Processing App Booking_Cancel for book_id: ${bookId}`);
              
              const cancelPayload = {
                canceled_by: 'App User',
                externalId: bookId
              };
              
              await sendTo24GolfApi(
                'Booking_Cancel', 
                '', 
                cancelPayload, 
                null, 
                currentToken, 
                processedBookings, 
                paymentAmounts, 
                paymentStatus
              );
              
              console.log(`[INFO] Processed App Booking_Cancel for book_id: ${bookId}`);
              processedAppBookings.add(bookId);
            } catch (error) {
              console.error(`[ERROR] Failed to process App Booking_Cancel: ${error.message}`);
            }
          } else {
            // 새 예약 처리
            const bookingData = {
              externalId: bookId,
              name: booking.name || 'Unknown',
              phone: booking.phone || '010-0000-0000',
              partySize: parseInt(booking.person || 1, 10),
              startDate: booking.start_datetime,
              endDate: booking.end_datetime,
              roomId: booking.room?.toString() || 'unknown',
              hole: booking.hole,
              paymented: finished,
              paymentAmount: amount,
              crawlingSite: 'KimCaddie',
              immediate: booking.immediate_booked || false
            };
            
            try {
              // Make sure we have a valid token
              let currentToken = accessToken;
              if (!currentToken) {
                currentToken = await getAccessToken();
              }
              
              console.log(`[INFO] Processing App Booking_Create for book_id: ${bookId}`);
              
              await sendTo24GolfApi(
                'Booking_Create', 
                '', 
                {}, 
                bookingData, 
                currentToken, 
                processedBookings, 
                paymentAmounts, 
                paymentStatus
              );
              
              console.log(`[INFO] Processed App Booking_Create for book_id: ${bookId}`);
              processedAppBookings.add(bookId);
            } catch (error) {
              console.error(`[ERROR] Failed to process App Booking_Create: ${error.message}`);
            }
          }
        }
      }
    }
    
    // 오래된 고객 업데이트 정보 정리
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    for (const [customerId, data] of customerUpdates.entries()) {
      if (data.timestamp < fiveMinutesAgo) {
        customerUpdates.delete(customerId);
      }
    }
    
    // 오래된 처리 정보 정리 (하루에 한 번)
    if (processedAppBookings.size > 1000) {
      console.log(`[INFO] Clearing old processed app bookings (size=${processedAppBookings.size})`);
      processedAppBookings.clear();
    }
  } catch (e) {
    console.error(`[ERROR] Failed to process app bookings: ${e.message}`);
  }
};

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
      const amount = revenueDetail.amount || 0;
      const finished = revenueDetail.finished || false;

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