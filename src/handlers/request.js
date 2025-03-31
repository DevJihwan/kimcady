const { parseMultipartFormData } = require('../utils/parser');
const { sendTo24GolfApi, getAccessToken } = require('../utils/api');

const setupRequestHandler = (page, accessToken, maps) => {
  const { requestMap, processedBookings, paymentAmounts, paymentStatus, bookIdToIdxMap, revenueToBookingMap, bookingDataMap } = maps;

  // 앱 예약 취소 처리를 위한 세트 추가
  const processedAppCancellations = new Set();

  page.on('request', async (request) => {
    const url = request.url();
    const method = request.method();
    const postData = request.postData();
    const headers = request.headers();

    console.log(`[DEBUG] Request captured - URL: ${url}, Method: ${method}`);

    if (!url.startsWith('https://api.kimcaddie.com/api/')) return;

    const payload = parsePayload(headers, postData);
    if (!payload) {
      console.log(`[WARN] Failed to parse payload for URL: ${url}`, method);
      return;
    }

    // 앱 예약 취소 처리 - confirm_state API
    if (url.includes('/api/booking/confirm_state') && (method === 'PATCH' || method === 'PUT')) {
      console.log(`[INFO] App booking state change detected - URL: ${url}, Method: ${method}`);
      console.log(`[DEBUG] App booking state change payload:`, JSON.stringify(payload, null, 2));
      
      // 예약 취소 감지
      if (payload.state === 'canceled' && payload.book_id) {
        const bookId = payload.book_id;
        
        // 이미 처리된 취소인지 확인
        if (processedAppCancellations.has(bookId) || processedBookings.has(bookId)) {
          console.log(`[INFO] Skipping already processed app cancellation for book_id: ${bookId}`);
          return;
        }
        
        console.log(`[INFO] App Booking_Cancel detected for book_id: ${bookId}`);
        try {
          // 유효한 토큰 확보
          let currentToken = accessToken;
          if (!currentToken) {
            currentToken = await getAccessToken();
          }
          
          // 취소 사유 추출 (있을 경우)
          let cancelReason = 'App User';
          if (payload.bookingInfo) {
            try {
              const bookingInfo = JSON.parse(payload.bookingInfo);
              if (bookingInfo.cancel_reason) {
                cancelReason = bookingInfo.cancel_reason;
              }
            } catch (e) {
              console.error(`[ERROR] Failed to parse bookingInfo: ${e.message}`);
            }
          }
          
          // 취소 API 호출
          const cancelPayload = {
            externalId: bookId,
            canceled_by: cancelReason
          };
          
          await sendTo24GolfApi(
            'Booking_Cancel', 
            url, 
            cancelPayload, 
            null, 
            currentToken, 
            processedBookings, 
            paymentAmounts, 
            paymentStatus
          );
          
          console.log(`[INFO] Processed App Booking_Cancel for book_id: ${bookId}`);
          processedAppCancellations.add(bookId);
        } catch (error) {
          console.error(`[ERROR] Failed to process App Booking_Cancel: ${error.message}`);
        }
      }
      
      // 요청 저장
      requestMap.set(url, { url, method, payload, type: 'App_Booking_State_Change' });
      return;
    }

    // 등록 (Booking_Create)
    if (url.includes('/owner/booking') && method === 'POST') {
      console.log(`[INFO] Booking_Create detected - URL: ${url}, Method: ${method}`);
      console.log(`[DEBUG] Booking_Create payload:`, JSON.stringify(payload, null, 2));
      bookingDataMap.set(url, { type: 'Booking_Create', payload, timestamp: Date.now() });
      requestMap.set(url, { url, method, payload, type: 'Booking_Create' });
    }

    // 변경 (Booking_Update) 및 취소 (Booking_Cancel)
    else if (url.includes('/booking/change_info') && method === 'PATCH') {
      let bookingId = extractBookingId(url);
      if (!bookingId) {
        console.log(`[ERROR] Failed to extract booking ID from URL: ${url}`);
        return;
      }

      payload.externalId = bookingId;
      console.log(`[DEBUG] Booking change detected - URL: ${url}, BookingId: ${bookingId}, Payload:`, JSON.stringify(payload, null, 2));

      // Check if it's a cancellation
      if (payload.state && payload.state === 'canceled') {
        console.log(`[INFO] Booking_Cancel detected for book_id: ${bookingId}`);
        try {
          // Make sure we have a valid token
          let currentToken = accessToken;
          if (!currentToken) {
            currentToken = await getAccessToken();
          }
          
          await sendTo24GolfApi(
            'Booking_Cancel', 
            url, 
            payload, 
            null, 
            currentToken, 
            processedBookings, 
            paymentAmounts, 
            paymentStatus
          );
          console.log(`[INFO] Processed Booking_Cancel for book_id: ${bookingId}`);
        } catch (error) {
          console.error(`[ERROR] Failed to process Booking_Cancel: ${error.message}`);
        }
      } else {
        // It's an update - store the information for later processing
        console.log(`[INFO] Booking_Update detected for book_id: ${bookingId} - storing for later processing`);
        
        // 중요: 예약 변경 정보 저장해두고 나중에 처리
        bookingDataMap.set(`pendingUpdate_${bookingId}`, {
          type: 'Booking_Update_Pending',
          url,
          payload,
          timestamp: Date.now()
        });
        
        // Booking update will be processed after receiving revenue & booking data
      }

      // Store in request map for further reference
      requestMap.set(url, { url, method, payload, bookingId });
    }

    // PATCH /owner/revenue/ - 결제 정보 업데이트
    else if (url.match(/\/owner\/revenue\/\d+\/$/) && method === 'PATCH') {
      const revenueId = extractRevenueId(url);
      if (revenueId) {
        console.log(`[INFO] Detected PATCH /owner/revenue/${revenueId}/`);
        
        // 결제 정보 추출
        if (payload && payload.amount !== undefined && payload.finished !== undefined) {
          const amount = parseInt(payload.amount, 10) || 0;
          const finished = payload.finished === 'true';
          const bookIdx = payload.book_idx;
          
          console.log(`[DEBUG] Revenue update detected for revenue ID ${revenueId}, book_idx ${bookIdx}: amount=${amount}, finished=${finished}`);
          
          // revenue ID로 booking ID 찾기
          const bookId = revenueToBookingMap.get(revenueId);
          if (bookId) {
            console.log(`[INFO] Found matching book_id ${bookId} for revenue ID ${revenueId}`);
            
            // 결제 정보 임시 저장 (나중에 booking 데이터와 함께 사용)
            requestMap.set(`revenueUpdate_${revenueId}`, {
              revenueId,
              bookId,
              bookIdx,
              amount,
              finished,
              timestamp: Date.now()
            });
            
            console.log(`[INFO] Stored revenue update for book_id ${bookId}: amount=${amount}, finished=${finished}`);
          } else {
            console.log(`[WARN] No matching book_id found for revenue ID ${revenueId}, storing temporary data`);
            // book_idx와 revenue ID 매핑 저장
            if (bookIdx) {
              requestMap.set(`revenueUpdate_${revenueId}`, {
                revenueId,
                bookIdx,
                amount,
                finished,
                timestamp: Date.now()
              });
            }
          }
        }
        
        requestMap.set(url, { url, method, payload, revenueId });
      }
    }
    
    // GET /owner/booking/ - 예약 목록 조회
    else if (url.includes('/owner/booking/') && method === 'GET') {
      console.log(`[INFO] Detected GET /owner/booking/ - will process pending updates after response`);
      // Response handler will take care of this
    }

    // Store all requests for reference
    requestMap.set(url, { url, method, payload });
  });

  // 5분마다 processedAppCancellations 세트 정리
  const cleanupInterval = setInterval(() => {
    if (processedAppCancellations.size > 500) {
      console.log(`[INFO] Clearing old processed app cancellations (size=${processedAppCancellations.size})`);
      processedAppCancellations.clear();
    }
  }, 5 * 60 * 1000); // 5분마다

  // 페이지 종료 시 정리
  page.once('close', () => {
    clearInterval(cleanupInterval);
  });

  return { processedAppCancellations };
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

const parsePayload = (headers, postData) => {
  if (!postData) {
    return {};
  }

  const contentType = headers['content-type'] || '';
  let payload = {};
  
  try {
    if (contentType.includes('multipart/form-data')) {
      payload = parseMultipartFormData(postData);
    } else if (contentType.includes('application/json')) {
      try {
        payload = JSON.parse(postData);
      } catch (e) {
        console.error(`[ERROR] Failed to parse JSON payload: ${e.message}`);
        payload = { raw: postData };
      }
    } else {
      payload = { raw: postData };
    }
  } catch (error) {
    console.error(`[ERROR] Failed to parse payload: ${error.message}`);
    return {};
  }
  
  return payload;
};

const extractBookingId = (url) => {
  try {
    return url.split('/').pop().split('?')[0];
  } catch (e) {
    console.error(`[ERROR] Failed to extract booking ID from URL: ${url}`);
    return null;
  }
};

module.exports = { setupRequestHandler };