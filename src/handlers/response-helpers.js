const { sendTo24GolfApi, getAccessToken } = require('../utils/api');

// 외부에서 처리된 예약 ID 추적용 집합
const processedBookingIds = new Set();
// 예약 생성 진행 중인 ID를 추적하는 집합
const pendingCreateBookingIds = new Set();

// 보류 중인 모든 예약 업데이트 처리
const processPendingBookingUpdates = async (accessToken, maps) => {
  const { bookingDataMap, requestMap } = maps;
  
  console.log('[INFO] Processing any pending booking updates after getting booking data');
  
  // Find all pending booking updates
  for (const [key, data] of bookingDataMap.entries()) {
    if (key.startsWith('pendingUpdate_') && data.type === 'Booking_Update_Pending') {
      const bookId = key.replace('pendingUpdate_', '');
      
      // 이미 처리된 예약인지 확인
      if (processedBookingIds.has(bookId)) {
        console.log(`[INFO] Skipping already processed booking update for ${bookId}`);
        continue;
      }
      
      // 진행 중인 예약 생성이 있는지 확인 - 있으면 처리하지 않음
      if (pendingCreateBookingIds.has(bookId)) {
        console.log(`[INFO] Skipping update for booking ${bookId} as it's being created`);
        continue;
      }
      
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
  
  // 새로 추가: 결제 정보만 업데이트된 예약 처리
  console.log('[INFO] Processing bookings with updated payment information');
  const { paymentAmounts, paymentStatus, bookIdToIdxMap } = maps;
  const processedIds = new Set();
  
  // 최근 결제 정보 업데이트 확인 (revenueUpdate_로 시작하는 키)
  for (const [key, data] of requestMap.entries()) {
    if (key.startsWith('revenueUpdate_') && data.bookId && !processedIds.has(data.bookId)) {
      const bookId = data.bookId;
      
      // 이미 처리된 예약인지 확인
      if (processedBookingIds.has(bookId)) {
        console.log(`[INFO] Skipping already processed payment update for ${bookId}`);
        continue;
      }
      
      // 중요: 예약 생성 중인 경우 스킵 (새로 추가)
      if (pendingCreateBookingIds.has(bookId)) {
        console.log(`[INFO] Skipping payment update for ${bookId} as it's being created`);
        continue;
      }
      
      // 생성된지 1분 이내의 예약은 스킵 (새로 생성된 예약은 이미 최신 결제 정보 포함)
      const bookingData = bookingDataMap.get(bookId);
      if (bookingData && (Date.now() - bookingData.timestamp < 60000)) {
        console.log(`[INFO] Skipping payment update for ${bookId} as it was recently created`);
        continue;
      }
      
      const amount = data.amount || 0;
      const finished = data.finished || false;
      const timestamp = data.timestamp || 0;
      
      // 최근 5분 이내의 업데이트만 처리 (오래된 데이터는 무시)
      if ((Date.now() - timestamp) < 300000) {
        console.log(`[INFO] Processing payment update for book_id ${bookId}: amount=${amount}, finished=${finished}`);
        
        try {
          // 업데이트 페이로드 생성
          const payload = {
            externalId: bookId,
            paymentAmount: amount,
            paymented: finished
          };
          
          // API 호출
          let currentToken = accessToken;
          if (!currentToken) {
            currentToken = await getAccessToken();
          }
          
          await sendTo24GolfApi(
            'Booking_Update', 
            `payment_update_${bookId}`, 
            { externalId: bookId },
            payload, 
            currentToken, 
            null,
            paymentAmounts, 
            paymentStatus
          );
          
          console.log(`[INFO] Successfully updated payment for book_id ${bookId}`);
          processedIds.add(bookId);
          processedBookingIds.add(bookId); // 처리 완료 표시
          
          // 처리 완료 후 맵에서 제거
          requestMap.delete(key);
        } catch (error) {
          console.error(`[ERROR] Failed to update payment for book_id ${bookId}: ${error.message}`);
        }
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
  
  // 이미 처리된 예약인지 확인
  if (processedBookingIds.has(bookId)) {
    console.log(`[INFO] Skipping already processed booking update for ${bookId}`);
    return;
  }
  
  // 중요: 예약 생성 중인 경우 스킵 (새로 추가)
  if (pendingCreateBookingIds.has(bookId)) {
    console.log(`[INFO] Skipping update for booking ${bookId} as it's being created`);
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
  processedBookingIds.add(bookingId); // 처리 완료 표시
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
      
      // 수정: finished가 null 또는 undefined인 경우 false로 처리
      const finished = revenueDetail.finished === true || revenueDetail.finished === 'true';

      // Store mappings
      if (revenueId) {
        revenueToBookingMap.set(revenueId, bookId);
      }
      bookIdToIdxMap.set(bookId, bookIdx);
      
      // Check if we have any pending revenue updates for this revenue ID
      const tmpRevenueKey = `revenueUpdate_${revenueId}`;
      const pendingRevenue = requestMap.get(tmpRevenueKey);
      
      if (pendingRevenue) {
        console.log(`[INFO] Found pending revenue update for book_id ${bookId} (revenue ID ${revenueId}): amount=${pendingRevenue.amount}, finished=${pendingRevenue.finished}`);
        
        // Use the more recent data from the PATCH request
        paymentAmounts.set(bookId, pendingRevenue.amount);
        paymentStatus.set(bookId, pendingRevenue.finished);
        
        // 중요: 이제 book_idx와 bookId를 연결하여 저장
        pendingRevenue.bookId = bookId;
        requestMap.set(tmpRevenueKey, pendingRevenue);
      } else {
        // Use the data from the booking listing
        paymentAmounts.set(bookId, parseInt(amount, 10) || 0);
        paymentStatus.set(bookId, finished);
      }

      console.log(`[INFO] Mapped revenue ${revenueId} to book_id ${bookId}, amount: ${paymentAmounts.get(bookId)}, finished: ${paymentStatus.get(bookId)}, idx: ${bookIdx}`);
      
      // 중요: book_idx로도 매핑 저장 (향후 결제 정보 업데이트에 필요)
      if (bookIdx) {
        requestMap.set(`bookIdx_${bookIdx}`, { bookId, timestamp: Date.now() });
      }
      
      // bookIdx와 관련된 결제 정보 업데이트가 있는지 확인
      const paymentUpdateKey = `paymentUpdate_${bookIdx}`;
      const paymentInfo = requestMap.get(paymentUpdateKey);
      
      if (paymentInfo && paymentInfo.processed === false) {
        console.log(`[INFO] Found matching book_id ${bookId} for book_idx ${bookIdx} in pending payment update`);
        
        // revenueUpdate 생성 또는 업데이트
        const revenueKey = `revenueUpdate_${paymentInfo.revenueId || 'unknown'}`;
        
        requestMap.set(revenueKey, {
          bookId,
          bookIdx,
          revenueId: paymentInfo.revenueId,
          amount: paymentInfo.amount,
          finished: paymentInfo.finished,
          timestamp: Date.now()
        });
        
        // 처리 표시
        paymentInfo.processed = true;
        paymentInfo.bookId = bookId;
        requestMap.set(paymentUpdateKey, paymentInfo);
        
        console.log(`[INFO] Created/updated revenue update for book_id ${bookId}: amount=${paymentInfo.amount}, finished=${paymentInfo.finished}`);
      }
    }
    
    // 여기서 결제 정보 업데이트가 필요한 예약만 처리하는 것으로 수정
    // processPendingPaymentUpdates(maps); - 삭제
    
    // 보류 중인 예약 업데이트에 대해서는 계속 처리
    processPendingBookingUpdates(accessToken, maps);
  } catch (e) {
    console.error(`[ERROR] Failed to parse /owner/booking/ response: ${e.message}`);
  }
};

// 새 함수: 보류 중인 결제 정보 처리
const processPendingPaymentUpdates = (maps) => {
  const { requestMap, bookIdToIdxMap } = maps;
  
  // 모든 결제 정보 업데이트 찾기
  for (const [key, data] of requestMap.entries()) {
    // book_idx를 기반으로 한 결제 정보 업데이트 검색
    if (key.startsWith('paymentUpdate_') && data.bookIdx && !data.processed) {
      const bookIdx = data.bookIdx;
      
      // bookIdx를 통해 bookId 찾기
      let bookId = null;
      for (const [id, idx] of bookIdToIdxMap.entries()) {
        if (idx === bookIdx) {
          bookId = id;
          break;
        }
      }
      
      if (bookId) {
        console.log(`[INFO] Found matching book_id ${bookId} for book_idx ${bookIdx} in pending payment update`);
        
        // 예약 생성 중인지 확인
        if (pendingCreateBookingIds.has(bookId)) {
          console.log(`[INFO] Skipping payment update for ${bookId} as it's being created`);
          continue;
        }
        
        // 해당 bookId로 revenueUpdate_를 생성하거나 업데이트
        const revenueKey = `revenueUpdate_${data.revenueId || 'unknown'}`;
        
        requestMap.set(revenueKey, {
          bookId,
          bookIdx,
          revenueId: data.revenueId,
          amount: data.amount,
          finished: data.finished,
          timestamp: Date.now()
        });
        
        // 처리 표시
        data.processed = true;
        data.bookId = bookId;
        requestMap.set(key, data);
        
        console.log(`[INFO] Created/updated revenue update for book_id ${bookId}: amount=${data.amount}, finished=${data.finished}`);
      } else {
        console.log(`[WARN] No book_id found for book_idx ${bookIdx} in pending payment update`);
      }
    }
  }
};

const handleRevenueResponse = async (response, request, maps) => {
  const { paymentAmounts, paymentStatus, bookIdToIdxMap, requestMap } = maps;
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
      // 중요: 해당 예약이 생성 중인지 확인
      if (pendingCreateBookingIds.has(bookId)) {
        console.log(`[INFO] Found booking ${bookId} in creation process, updating payment info`);
        paymentAmounts.set(bookId, amount);
        paymentStatus.set(bookId, finished);
        return { bookId, amount, finished };
      }
      
      paymentAmounts.set(bookId, amount);
      paymentStatus.set(bookId, finished);
      console.log(`[INFO] Updated payment for book_id ${bookId} (book_idx ${bookIdx}): amount=${amount}, finished=${finished}`);
      
      // 중요: 결제 정보 업데이트 저장 (나중에 API 호출에 사용)
      const revenueId = responseData?.id || null;
      const revenueKey = `revenueUpdate_${revenueId || 'unknown'}`;
      
      requestMap.set(revenueKey, {
        bookId,
        bookIdx,
        revenueId,
        amount,
        finished,
        timestamp: Date.now()
      });
      
      console.log(`[INFO] Stored payment update for book_id ${bookId} in requestMap`);
      
      return { bookId, amount, finished };
    } else {
      console.log(`[WARN] No book_id found for book_idx ${bookIdx}`);
      
      // 중요: book_id를 즉시 찾을 수 없으면 임시 저장
      // - 나중에 booking 데이터가 로드되면 처리됨
      const revenueId = responseData?.id || null;
      const paymentKey = `paymentUpdate_${bookIdx}`;
      
      requestMap.set(paymentKey, {
        bookIdx,
        revenueId,
        amount, 
        finished,
        processed: false,
        timestamp: Date.now()
      });
      
      console.log(`[INFO] Stored pending payment update for book_idx ${bookIdx}: amount=${amount}, finished=${finished}`);
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
    
    // 이 예약이 현재 처리 중이라고 표시
    pendingCreateBookingIds.add(bookId);
    
    // 이미 처리된 예약인지 확인
    if (processedBookingIds.has(bookId)) {
      console.log(`[INFO] Skipping already processed booking create for ${bookId}`);
      return;
    }
    
    bookIdToIdxMap.set(bookId, responseData.idx?.toString() || '');
    
    // Store the booking data with timestamp
    bookingDataMap.set(bookId, { 
      type: 'Booking_Create', 
      payload: requestData.payload, 
      response: responseData, 
      timestamp: Date.now() 
    });

    console.log(`[INFO] Booking_Create stored for book_id ${bookId}, idx: ${responseData.idx}`);
    
    // 완료 후 처리 중 목록에서 제거
    setTimeout(() => {
      pendingCreateBookingIds.delete(bookId);
      console.log(`[INFO] Removed ${bookId} from pending creation list`);
    }, 5000); // 5초 후에 예약 생성 중 목록에서 제거
    
    // 결제 정보 확인은 생략 - 이제 request.js에서 직접 처리함
    processedBookingIds.add(bookId); // 처리 완료 표시
    
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
  handleBookingCreateResponse,
  processPendingPaymentUpdates,
  pendingCreateBookingIds  // 예약 생성 중 목록을 외부에 노출
};
