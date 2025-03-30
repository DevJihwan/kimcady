const { parseMultipartFormData } = require('../utils/parser');
const { sendTo24GolfApi, getAccessToken } = require('../utils/api');

const setupRequestHandler = (page, accessToken, maps) => {
  const { requestMap, processedBookings, paymentAmounts, paymentStatus, bookIdToIdxMap, bookingDataMap } = maps;

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

    // PATCH /owner/revenue/
    else if (url.match(/\/owner\/revenue\/\d+\/$/) && method === 'PATCH') {
      const revenueId = parseInt(url.split('/').slice(-2)[0], 10);
      console.log(`[INFO] Detected PATCH /owner/revenue/${revenueId}/`);
      requestMap.set(url, { url, method, payload, revenueId });
    }

    // Store all requests for reference
    requestMap.set(url, { url, method, payload });
  });
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
    }
    
    if (existingStatus) {
      console.log(`[INFO] Using existing payment status for book_id ${bookingId}: ${existingStatus}`);
      paymentStatusFromDom = existingStatus;
    }

    // DOM에서도 결제 정보를 추출 시도
    try {
      await page.waitForSelector('.sc-pktCe.dSKYub .sc-pAyMl.fkDqVf', { timeout: 5000 });
      const paymentAmountText = await page.$eval('.sc-pktCe.dSKYub .sc-pAyMl.fkDqVf', el => el.textContent.trim());
      const extractedAmount = parseInt(paymentAmountText.replace(/[^0-9]/g, ''), 10) || 0;
      
      if (extractedAmount > 0) {
        paymentAmountFromDom = extractedAmount;
        paymentStatusFromDom = true; // 금액이 있으면 결제 완료로 간주
        console.log(`[INFO] Extracted payment amount from DOM: ${paymentAmountFromDom}`);
      }
    } catch (domError) {
      console.log(`[WARN] Could not extract payment info from DOM: ${domError.message}`);
      // Try alternative selectors if needed
      try {
        // Try a more general selector
        await page.waitForSelector('[class*="sc-"][class*="pAyMl"]', { timeout: 3000 });
        const elements = await page.$$('[class*="sc-"][class*="pAyMl"]');
        for (const el of elements) {
          const text = await page.evaluate(element => element.textContent, el);
          if (text && /\d+/.test(text)) {
            const extractedAmount = parseInt(text.replace(/[^0-9]/g, ''), 10) || 0;
            if (extractedAmount > 0) {
              paymentAmountFromDom = extractedAmount;
              paymentStatusFromDom = true;
              console.log(`[INFO] Found payment amount using alternative selector: ${paymentAmountFromDom}`);
              break;
            }
          }
        }
      } catch (altError) {
        console.log(`[WARN] Alternative DOM extraction also failed: ${altError.message}`);
      }
    }

    // Wait a bit to ensure we have all data
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // 최종 결제 정보 결정
    // 우선순위: DOM에서 추출 > 맵에 저장된 값 > 기본값
    if (paymentAmountFromDom <= 0) {
      paymentAmountFromDom = existingAmount || 0;
    }
    
    if (!paymentStatusFromDom) {
      paymentStatusFromDom = existingStatus || false;
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