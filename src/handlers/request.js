const { parseMultipartFormData } = require('../utils/parser');
const { sendTo24GolfApi, getAccessToken } = require('../utils/api');

const setupRequestHandler = (page, accessToken, maps) => {
  const { requestMap, processedBookings, paymentAmounts, paymentStatus, bookIdToIdxMap, revenueToBookingMap, bookingDataMap } = maps;

  page.on('request', async (request) => {
    const url = request.url();
    const method = request.method();
    const postData = request.postData();
    const headers = request.headers();

    console.log(`[DEBUG] Request captured - URL: ${url}, Method: ${method}`);

    if (!url.startsWith('https://api.kimcaddie.com/api/')) return;

    const payload = parsePayload(headers, postData);
    if (!payload) {
      console.log(`[WARN] Failed to parse payload for URL: ${url}`);
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

      // 이미 결제 정보가 있는지 확인 및 로깅
      const existingPaymentAmount = paymentAmounts.get(bookingId) || 0;
      const existingPaymentStatus = paymentStatus.get(bookingId) || false;
      console.log(`[DEBUG] Existing payment info for ${bookingId}: Amount=${existingPaymentAmount}, Completed=${existingPaymentStatus}`);

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
        // It's an update
        console.log(`[INFO] Booking_Update detected for book_id: ${bookingId}`);
        try {
          await handleBookingUpdate(page, url, payload, accessToken, maps);
        } catch (error) {
          console.error(`[ERROR] Failed to process Booking_Update: ${error.message}`);
        }
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
            
            // 결제 정보 업데이트
            paymentAmounts.set(bookId, amount);
            paymentStatus.set(bookId, finished);
            
            console.log(`[INFO] Updated payment info for book_id ${bookId}: amount=${amount}, finished=${finished}`);
          } else {
            console.log(`[WARN] No matching book_id found for revenue ID ${revenueId}, storing temporary data`);
            // book_idx와 revenue ID 매핑 저장
            if (bookIdx) {
              const tmpData = { revenueId, bookIdx, amount, finished, timestamp: Date.now() };
              requestMap.set(`tmp_revenue_${revenueId}`, tmpData);
            }
          }
        }
        
        requestMap.set(url, { url, method, payload, revenueId });
      }
    }

    // Store all requests for reference
    requestMap.set(url, { url, method, payload });
  });
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

const handleBookingUpdate = async (page, url, payload, accessToken, maps) => {
  const { processedBookings, paymentAmounts, paymentStatus } = maps;
  const bookingId = payload.externalId;
  let paymentAmountFromDom = 0;
  let paymentStatusFromDom = false;

  console.log(`[INFO] Processing Booking_Update for book_id: ${bookingId}`);

  try {
    // 이미 저장된 결제 정보가 있는지 먼저 확인
    const existingAmount = paymentAmounts.get(bookingId);
    const existingStatus = paymentStatus.get(bookingId);
    
    if (existingAmount && existingAmount > 0) {
      console.log(`[INFO] Using existing payment amount for book_id ${bookingId}: ${existingAmount}`);
      paymentAmountFromDom = existingAmount;
      
      // 중요: 금액이 있더라도 기존 상태를 그대로 유지
      if (existingStatus !== undefined) {
        paymentStatusFromDom = existingStatus;
        console.log(`[INFO] Using existing payment status for book_id ${bookingId}: ${existingStatus}`);
      }
    }

    // DOM에서도 결제 정보를 추출 시도 (특수 상황에서만 사용)
    if (paymentAmountFromDom <= 0) {
      try {
        await page.waitForSelector('.sc-pktCe.dSKYub .sc-pAyMl.fkDqVf', { timeout: 5000 });
        const paymentAmountText = await page.$eval('.sc-pktCe.dSKYub .sc-pAyMl.fkDqVf', el => el.textContent.trim());
        const extractedAmount = parseInt(paymentAmountText.replace(/[^0-9]/g, ''), 10) || 0;
        
        if (extractedAmount > 0) {
          paymentAmountFromDom = extractedAmount;
          console.log(`[INFO] Extracted payment amount from DOM: ${paymentAmountFromDom}`);
          
          // 중요: DOM에서 상태를 가져올 순 없으니 기존 상태 유지
          if (existingStatus !== undefined) {
            paymentStatusFromDom = existingStatus;
          }
        }
      } catch (domError) {
        console.log(`[WARN] Could not extract payment info from DOM: ${domError.message}`);
        // 대안 시도는 생략
      }
    }

    // Wait a bit to ensure we have all data
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // 최종 결제 정보 결정
    // 우선순위: 저장된 값 > DOM에서 추출(금액만) > 기본값
    if (paymentAmountFromDom <= 0) {
      paymentAmountFromDom = existingAmount || 0;
    }
    
    if (existingStatus !== undefined) {
      // 이미 저장된 상태가 있으면 그대로 사용
      paymentStatusFromDom = existingStatus;
    }

    console.log(`[INFO] Final payment status for book_id ${bookingId}: ${paymentStatusFromDom}`);
    console.log(`[INFO] Final payment amount for book_id ${bookingId}: ${paymentAmountFromDom}`);
    
    // 맵 업데이트
    paymentAmounts.set(bookingId, paymentAmountFromDom);
    paymentStatus.set(bookingId, paymentStatusFromDom);
  } catch (e) {
    console.error(`[ERROR] Failed to process payment info: ${e.message}`);
    // 에러 발생 시 맵에 저장된 값 사용
    paymentAmountFromDom = paymentAmounts.get(bookingId) || 0;
    paymentStatusFromDom = paymentStatus.get(bookingId) || false;
  }

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

module.exports = { setupRequestHandler };