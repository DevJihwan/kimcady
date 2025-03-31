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