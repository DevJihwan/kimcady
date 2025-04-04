const { parseMultipartFormData } = require('../utils/parser');
const { sendTo24GolfApi, getAccessToken, convertKSTtoUTC } = require('../utils/api');
const { generateRandomBookId } = require('../utils/helpers');

const setupRequestHandler = (page, accessToken, maps) => {
  const { requestMap, processedBookings, paymentAmounts, paymentStatus, bookIdToIdxMap, revenueToBookingMap, bookingDataMap } = maps;

  page.on('request', async (request) => {
    const url = request.url();
    const method = request.method();
    const postData = request.postData();
    const headers = request.headers();

    //console.log(`[DEBUG] Request captured - URL: ${url}, Method: ${method}`);

    if (!url.startsWith('https://api.kimcaddie.com/api/')) return;

    const payload = parsePayload(headers, postData);
    if (!payload) {
      console.log(`[WARN] Failed to parse payload for URL: ${url}`);
      return;
    }

    // 앱 예약 취소 처리 (confirm_state API)
    if (url.includes('/api/booking/confirm_state') && (method === 'PATCH' || method === 'PUT')) {
      console.log(`[INFO] App booking state change detected - URL: ${url}, Method: ${method}`);
      console.log(`[DEBUG] App booking state change payload:`, JSON.stringify(payload, null, 2));
      
      // 예약 취소 확인
      if (payload.state === 'canceled' && payload.book_id) {
        const bookId = payload.book_id;
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
              
              // 결제 금액 정보 추출 (있을 경우)
              if (bookingInfo.amount) {
                const amount = parseInt(bookingInfo.amount, 10) || 0;
                console.log(`[INFO] Extracted payment amount ${amount} from bookingInfo for book_id: ${bookId}`);
                paymentAmounts.set(bookId, amount);
              }
            } catch (e) {
              console.error(`[ERROR] Failed to parse bookingInfo: ${e.message}`);
            }
          }
          
          // 기존 세트에서 제거 (재처리를 위해)
          processedBookings.delete(bookId);
          
          // 취소 API 호출
          const cancelPayload = {
            externalId: bookId,
            canceled_by: cancelReason
          };
          
          console.log(`[INFO] Sending cancel request to 24Golf API for book_id: ${bookId}`);
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
          
          console.log(`[INFO] Successfully processed App Booking_Cancel for book_id: ${bookId}`);
        } catch (error) {
          console.error(`[ERROR] Failed to process App Booking_Cancel: ${error.message}`);
        }
      }
      
      // 요청 저장
      requestMap.set(url, { url, method, payload, type: 'App_Booking_State_Change' });
    }

    // 등록 (Booking_Create)
    else if (url.includes('/owner/booking') && method === 'POST') {
      console.log(`[INFO] Booking_Create detected - URL: ${url}, Method: ${method}`);
      console.log(`[DEBUG] Booking_Create payload:`, JSON.stringify(payload, null, 2));
      
      // 점주 웹사이트에서 예약 등록 처리
      if (payload.book_type === 'M' || !payload.book_id) {
        // 시간 형식 변환 (KST -> UTC)
        const startDate = convertKSTtoUTC(payload.start_datetime);
        const endDate = convertKSTtoUTC(payload.end_datetime);
        
        console.log(`[DEBUG] Manager booking - converting time: ${payload.start_datetime} -> ${startDate}`);
        
        // 올바른 형식의 예약 ID 생성 (임시 ID가 아닌 실제 형식 사용)
        const realBookId = generateRandomBookId();
        
        // 결제 정보를 확인하기 위해, 생성 전에 잠시 지연
        const bookingInfo = {
          bookId: realBookId,
          url,
          payload,
          startDate,
          endDate,
          timestamp: Date.now()
        };
        
        // requestMap에 예약 정보 저장
        requestMap.set(`bookingCreate_${realBookId}`, bookingInfo);
        
        console.log(`[INFO] Delaying booking creation for bookId: ${realBookId} to gather payment information`);
        
        // 예약 정보를 API로 전송하기 전 결제 정보 대기
        setTimeout(async () => {
          try {
            let currentToken = accessToken;
            if (!currentToken) {
              currentToken = await getAccessToken();
            }
            
            // 최신 결제 정보 확인
            // 이 시점에 이미 결제 정보가 수집되었을 수 있음
            const latestPaymentInfo = findLatestPaymentInfo(requestMap);
            let amount = 0;
            let finished = false;
            
            if (latestPaymentInfo) {
              amount = latestPaymentInfo.amount || 0;
              finished = latestPaymentInfo.finished || false;
              console.log(`[INFO] Found payment information for new booking: amount=${amount}, finished=${finished}`);
            }
            
            // 예약자 이름 추출 (payload에서 추출 또는 기본값 'Guest')
            const guestName = payload.name || 'Guest';
            
            // 예약 데이터 준비
            const apiData = {
              externalId: realBookId,
              name: guestName,
              phone: payload.phone || '010-0000-0000',
              partySize: parseInt(payload.person || 1, 10),
              startDate: startDate,
              endDate: endDate,
              roomId: payload.room_id?.toString() || 'unknown',
              hole: payload.hole || '18',
              paymented: finished,
              paymentAmount: amount,
              crawlingSite: 'KimCaddie',
              immediate: false
            };
            
            console.log(`[INFO] Processing Manager Booking_Create with complete information: ${JSON.stringify(apiData, null, 2)}`);
            
            // 실제 API 호출
            await sendTo24GolfApi(
              'Booking_Create',
              url,
              payload,
              apiData,
              currentToken,
              processedBookings,
              paymentAmounts,
              paymentStatus
            );
            
            console.log(`[INFO] Sent Manager Booking_Create to 24Golf API with amount: ${amount}`);
            
            // 요청 맵에서 제거
            requestMap.delete(`bookingCreate_${realBookId}`);
          } catch (error) {
            console.error(`[ERROR] Failed to process Manager Booking_Create: ${error.message}`);
          }
        }, 2000); // 2초 대기 - 결제 정보가 들어오기를 기다림
      }
      
      // 결제 정보 추출 시도
      if (payload.amount) {
        const amount = parseInt(payload.amount, 10) || 0;
        const bookId = payload.book_id;
        if (bookId && amount > 0) {
          console.log(`[INFO] Extracted payment amount ${amount} from create payload for book_id: ${bookId}`);
          paymentAmounts.set(bookId, amount);
        }
      }
      
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
            
            // 결제 금액 정보 즉시 업데이트
            paymentAmounts.set(bookId, amount);
            paymentStatus.set(bookId, finished);
            
            console.log(`[INFO] Stored and updated payment for book_id ${bookId}: amount=${amount}, finished=${finished}`);
          } else {
            console.log(`[WARN] No matching book_id found for revenue ID ${revenueId}, storing temporary data`);
            // book_idx와 revenue ID 매핑 저장
            if (bookIdx) {
              requestMap.set(`paymentUpdate_${bookIdx}`, {
                revenueId,
                bookIdx,
                amount,
                finished,
                processed: false,
                timestamp: Date.now()
              });
              
              // 중요: 새로 추가 - 현재 보류 중인 예약 생성이 있는지 확인
              updatePendingBookingWithPayment(requestMap, bookIdx, amount, finished);
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
  
  // 정리 인터벌 추가
  const cleanupInterval = setInterval(() => {
    // 필요에 따라 주기적인 정리 작업 추가 가능
    // 오래된 requestMap 항목 제거
    const now = Date.now();
    const keysToDelete = [];
    
    for (const [key, data] of requestMap.entries()) {
      if (data.timestamp && (now - data.timestamp > 3600000)) { // 1시간 이상 지난 항목
        keysToDelete.push(key);
      }
    }
    
    for (const key of keysToDelete) {
      requestMap.delete(key);
    }
    
    if (keysToDelete.length > 0) {
      console.log(`[INFO] Cleaned up ${keysToDelete.length} old entries from requestMap`);
    }
  }, 60 * 60 * 1000); // 1시간마다
  
  // 페이지 종료 시 정리
  page.once('close', () => {
    clearInterval(cleanupInterval);
  });
};

// 최신 결제 정보 찾기
const findLatestPaymentInfo = (requestMap) => {
  let latestPaymentInfo = null;
  let latestTimestamp = 0;
  
  for (const [key, data] of requestMap.entries()) {
    if ((key.startsWith('revenueUpdate_') || key.startsWith('paymentUpdate_')) && 
        data.amount && data.timestamp > latestTimestamp) {
      latestPaymentInfo = data;
      latestTimestamp = data.timestamp;
    }
  }
  
  return latestPaymentInfo;
};

// 보류 중인 예약에 결제 정보 업데이트
const updatePendingBookingWithPayment = (requestMap, bookIdx, amount, finished) => {
  for (const [key, data] of requestMap.entries()) {
    if (key.startsWith('bookingCreate_') && data.bookId) {
      console.log(`[INFO] Found pending booking creation, adding payment info: amount=${amount}, finished=${finished}`);
      data.paymentAmount = amount;
      data.paymentFinished = finished;
      data.paymentTimestamp = Date.now();
      requestMap.set(key, data);
    }
  }
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
