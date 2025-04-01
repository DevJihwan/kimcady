const { sendTo24GolfApi, getAccessToken } = require('../utils/api');
const { parseMultipartFormData } = require('../utils/parser');
const {
  processPendingBookingUpdates,
  findBookIdByRevenueIdOrBookIdx,
  extractRevenueId,
  handleBookingListingResponse,
  handleRevenueResponse,
  handleBookingCreateResponse
} = require('./response-helpers');

// 추가한 전역 변수 - API 요청 중복 방지를 위한 Set
let processedCustomerRequests = new Set();
// 예약 데이터 캐시를 저장할 객체
let bookingDataCache = {
  timestamp: 0,
  data: null
};

const setupResponseHandler = (page, accessToken, maps) => {
  const { requestMap, processedBookings, paymentAmounts, paymentStatus, bookIdToIdxMap, revenueToBookingMap, bookingDataMap } = maps;
  
  // 새로운 맵 추가 - 앱 예약 처리용
  const customerUpdates = new Map(); // 최근 고객 정보 업데이트 저장
  const processedAppBookings = new Set(); // 처리된 앱 예약 ID 저장
  const recentCustomerIds = new Set(); // 최근 확인한 고객 ID 저장

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
      // 예약 상태 변경 API (예약 확정)
      if (url.includes('/api/booking/confirm_state') && method === 'PATCH' && status === 200) {
        console.log(`[INFO] App booking state change detected - URL: ${url}, Method: ${method}`);
        
        // 페이로드 파싱
        const patchPayload = parseMultipartFormData(request.postData());
        if (patchPayload) {
          console.log(`[DEBUG] App booking state change payload:`, JSON.stringify(patchPayload, null, 2));
          
          // book_id와 state 추출
          const bookId = patchPayload.book_id;
          const state = patchPayload.state;
          const room = patchPayload.room;
          
          if (bookId && state === 'success') {
            console.log(`[INFO] Detected booking confirmation: bookId=${bookId}, room=${room}, state=${state}`);
            
            try {
              // 예약 정보 추출
              let bookingInfo = {};
              if (patchPayload.bookingInfo) {
                try {
                  bookingInfo = JSON.parse(patchPayload.bookingInfo);
                  console.log(`[DEBUG] Parsed booking info:`, JSON.stringify(bookingInfo, null, 2));
                } catch (e) {
                  console.error(`[ERROR] Failed to parse bookingInfo JSON: ${e.message}`);
                }
              }
              
              // 예약 정보에서 필요한 데이터 추출
              const name = bookingInfo.name || patchPayload.name || 'Unknown';
              const phone = bookingInfo.phone || patchPayload.phone || '010-0000-0000';
              const partySize = parseInt(bookingInfo.person || patchPayload.person || 1, 10);
              const startDate = bookingInfo.start_datetime || null;
              const endDate = bookingInfo.end_datetime || null;
              const roomId = room || bookingInfo.room || 'unknown';
              const amount = parseInt(bookingInfo.amount || 0, 10);
              const hole = bookingInfo.hole || '9';
              
              console.log(`[DEBUG] Extracted booking data - name: ${name}, startDate: ${startDate}, roomId: ${roomId}`);
              
              // 결제 완료 여부 (항상 false로 설정)
              const finished = false;
              
              // 맵에 저장
              if (amount > 0) {
                paymentAmounts.set(bookId, amount);
              }
              paymentStatus.set(bookId, finished);
              
              // 예약 데이터 준비 - 직접 변수 값 지정하여 명확하게 처리
              const apiData = {
                externalId: bookId,
                name: name,
                phone: phone,
                partySize: partySize,
                startDate: startDate,
                endDate: endDate,
                roomId: roomId,
                hole: hole,
                paymented: finished,
                paymentAmount: amount,
                crawlingSite: 'KimCaddie',
                immediate: false
              };
              
              // 유효한 토큰 확인
              let currentToken = accessToken;
              if (!currentToken) {
                currentToken = await getAccessToken();
              }
              
              console.log(`[INFO] Processing Confirmed Booking_Create for book_id: ${bookId}`);
              console.log(`[DEBUG] Sending API data for confirmed booking:`, JSON.stringify(apiData, null, 2));
              
              // 예약 등록 API 호출 - 직접 apiData 객체를 전달
              await sendTo24GolfApi(
                'Booking_Create', 
                '', 
                {}, 
                apiData, 
                currentToken, 
                processedBookings, 
                paymentAmounts, 
                paymentStatus
              );
              
              console.log(`[INFO] Processed Confirmed Booking_Create for book_id: ${bookId}`);
              processedAppBookings.add(bookId);
            } catch (error) {
              console.error(`[ERROR] Failed to process confirmed booking: ${error.message}`);
              console.error(`[ERROR] Stack trace:`, error.stack);
            }
          }
        }
      }

      // 고객 정보 API (앱 예약 감지)
      else if (url.includes('/api/owner/customer/') && method === 'GET' && status === 200) {
        console.log(`[DEBUG] Processing customer info API response: ${url}`);
        const customerId = await handleCustomerResponse(response, customerUpdates);
        
        // 고객 ID가 있으면 10초 후에 예약 확인
        if (customerId) {
          console.log(`[DEBUG] Detected customerId: ${customerId}`);
          // 이미 처리 중인 고객 ID는 건너뜀
          if (recentCustomerIds.has(customerId) || processedCustomerRequests.has(customerId)) {
            console.log(`[INFO] Already processing customer ${customerId}, skipping duplicate check`);
            return;
          }
          
          // 요청 중복 방지
          recentCustomerIds.add(customerId);
          processedCustomerRequests.add(customerId);
          console.log(`[INFO] Added customer ${customerId} to recent checks, will process after booking data is received`);
          
          // 최신 예약 데이터를 얻은 후 처리 (10초 후)
          setTimeout(async () => {
            try {
              // 캐시된 예약 데이터가 있으면 사용
              if (bookingDataCache.data && (Date.now() - bookingDataCache.timestamp < 60000)) {
                console.log(`[INFO] Using cached booking data from ${new Date(bookingDataCache.timestamp).toISOString()}`);
                processCustomerBookings(customerId, bookingDataCache.data, accessToken, maps, processedBookings, processedAppBookings);
              } else {
                console.log(`[INFO] Waiting for next booking data to process customer ${customerId}`);
                // 다음 예약 데이터가 수신될 때까지 기다림 - 주기적으로 요청되는 데이터
              }
            } catch (e) {
              console.error(`[ERROR] Failed to process customer ${customerId} bookings: ${e.message}`);
            } finally {
              // 처리 완료 후 Set에서 제거
              recentCustomerIds.delete(customerId);
              // 1분 후에 processedCustomerRequests에서 제거 (중복 요청 방지 해제)
              setTimeout(() => {
                processedCustomerRequests.delete(customerId);
                console.log(`[INFO] Removed customer ${customerId} from processed requests after 1 minute`);
              }, 60000);
              console.log(`[INFO] Removed customer ${customerId} from recent checks after processing`);
            }
          }, 10000);
        }
      }
      
      // /owner/booking/ GET 응답 처리 (Getting existing bookings and payment info)
      else if (url.includes('/owner/booking/') && method === 'GET' && status === 200) {
        console.log(`[INFO] Detected GET /owner/booking/ - will process pending updates after response`);
        const responseJson = await response.json();
        console.log(`[DEBUG] Received booking data, caching it for future use`);
        
        // 예약 데이터 캐싱
        bookingDataCache = {
          timestamp: Date.now(),
          data: responseJson
        };
        
        // 일반 예약 데이터 처리
        await handleBookingListingResponse(response, maps);
        
        // 앱 예약 처리 시도 (최근 업데이트된 고객 정보 기반)
        await processAppBookings(response, accessToken, maps, customerUpdates, processedAppBookings);
        
        // After processing booking listing, we need to process any pending booking updates
        await processPendingBookingUpdates(accessToken, maps);
        
        // 현재 대기 중인 고객 ID에 대한 예약 처리
        console.log(`[INFO] Processing ${recentCustomerIds.size} pending customer IDs with fresh booking data`);
        for (const customerId of recentCustomerIds) {
          processCustomerBookings(customerId, responseJson, accessToken, maps, processedBookings, processedAppBookings);
        }
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
      console.error(`[ERROR] Stack trace:`, error.stack);
    }
  });
};

// 고객별 예약 처리 함수
const processCustomerBookings = (customerId, bookingData, accessToken, maps, processedBookings, processedAppBookings) => {
  console.log(`[INFO] Processing bookings for customer ${customerId}`);
  const { paymentAmounts, paymentStatus } = maps;
  
  try {
    if (!bookingData.results || !Array.isArray(bookingData.results)) {
      console.log(`[WARN] No booking results found in data`);
      return;
    }
    
    // 고객 ID에 해당하는 예약만 필터링
    const customerBookings = bookingData.results.filter(booking => 
      booking.customer === customerId && 
      booking.state === 'success' &&
      !processedBookings.has(booking.book_id) &&
      !processedAppBookings.has(booking.book_id)
    );
    
    console.log(`[INFO] Found ${customerBookings.length} success bookings for customer ${customerId}`);
    
    if (customerBookings.length > 0) {
      // 최신 업데이트 순으로 정렬
      customerBookings.sort((a, b) => {
        const aDate = new Date(a.customer_detail?.customerinfo_set?.[0]?.upd_date || 0);
        const bDate = new Date(b.customer_detail?.customerinfo_set?.[0]?.upd_date || 0);
        return bDate - aDate;
      });
      
      // 최신 예약 처리
      for (const booking of customerBookings) {
        const bookId = booking.book_id;
        console.log(`[DEBUG] Processing booking: ${bookId}`);
        
        // 결제 정보 가져오기
        const revenueDetail = booking.revenue_detail || {};
        const amount = parseInt(revenueDetail.amount || booking.amount || 0, 10);
        
        // 결제 완료 여부 확인 (finished가 true인 경우에만 true)
        const finished = revenueDetail.finished === true || revenueDetail.finished === 'true';
        
        console.log(`[DEBUG] Booking info - book_id: ${bookId}, customer: ${booking.customer}, state: ${booking.state}`);
        console.log(`[DEBUG] Extracted payment info for book_id ${bookId}: amount=${amount}, finished=${finished}, revenue_detail:`, JSON.stringify(revenueDetail));
        
        // 맵에 저장
        paymentAmounts.set(bookId, amount);
        paymentStatus.set(bookId, finished);
        
        // 예약 처리
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
          // 유효한 토큰 확인
          let currentToken = accessToken;
          if (!currentToken) {
            console.log(`[DEBUG] No access token available, fetching new one`);
            currentToken = getAccessToken();
          }
          
          console.log(`[INFO] Processing Auto Booking_Create for book_id: ${bookId}`);
          console.log(`[DEBUG] Sending API data for auto booking:`, JSON.stringify(bookingData, null, 2));
          
          // 예약 등록 API 호출
          sendTo24GolfApi(
            'Booking_Create', 
            '', 
            {}, 
            bookingData, 
            currentToken, 
            processedBookings, 
            paymentAmounts, 
            paymentStatus
          );
          
          console.log(`[INFO] Requested Auto Booking_Create for book_id: ${bookId}`);
          processedAppBookings.add(bookId);
        } catch (error) {
          console.error(`[ERROR] Failed to process Auto Booking_Create: ${error.message}`);
        }
      }
    } else {
      console.log(`[INFO] No new success bookings found for customer ${customerId}`);
    }
  } catch (e) {
    console.error(`[ERROR] Failed to process customer bookings: ${e.message}`);
  }
};

// 고객 정보 응답 처리 (앱 예약 감지용)
const handleCustomerResponse = async (response, customerUpdates) => {
  try {
    const customerData = await response.json();
    
    if (!customerData || !customerData.id) {
      console.log(`[WARN] Invalid customer data response format`);
      return null;
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
    
    return customerId;
  } catch (e) {
    console.error(`[ERROR] Failed to parse customer response: ${e.message}`);
    return null;
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

      // 예약 상태 체크
      const isCanceled = booking.state === 'canceled';
      const isSuccessful = booking.state === 'success';
      
      // 앱 예약만 찾기 (book_type이 'U' 또는 confirmed_by가 'IM' 또는 immediate_booked가 true)
      const isAppBooking = booking.book_type === 'U' || booking.confirmed_by === 'IM' || booking.immediate_booked === true;
      
      if (isAppBooking) {
        // 고객 업데이트 시간과 예약의 업데이트 시간 비교
        let matchingUpdate = false;
        
        // 고객 정보가 있고 최근 업데이트된 경우
        if (customerUpdate) {
          // 예약의 customerinfo_set의 upd_date와 고객 업데이트 시간을 비교
          if (booking.customer_detail && 
              booking.customer_detail.customerinfo_set && 
              booking.customer_detail.customerinfo_set.length > 0) {
            
            const bookingUpdTime = new Date(booking.customer_detail.customerinfo_set[0].upd_date).getTime();
            const customerUpdTime = customerUpdate.updateTime;
            
            // 시간 차이가 1초 이내면 같은 업데이트로 간주
            const timeDiff = Math.abs(bookingUpdTime - customerUpdTime);
            if (timeDiff < 1000) {
              console.log(`[INFO] Found matching update times for booking ${bookId}: booking=${new Date(bookingUpdTime).toISOString()}, customer=${new Date(customerUpdTime).toISOString()}`);
              matchingUpdate = true;
            }
          }
        }
        
        // 최근 업데이트 매칭 여부 또는 즉시 예약 여부 확인
        const isRecentUpdate = matchingUpdate || (Date.now() - (customerUpdate?.timestamp || 0) < 60 * 1000); // 1분 이내
        const isImmediateBooking = booking.immediate_booked === true || booking.confirmed_by === 'IM';
        
        // 매칭되는 업데이트가 있거나 즉시 예약이거나 취소된 예약 처리
        if (isRecentUpdate || isImmediateBooking || isCanceled) {
          const bookingState = isCanceled ? 'canceled' : (isSuccessful ? 'successful' : 'regular');
          const bookingType = isImmediateBooking ? 'immediate' : 'standard';
          
          console.log(`[INFO] Detected ${bookingState} ${bookingType} app booking: bookId=${bookId}, customerId=${customerId}, state=${booking.state}`);
          
          // 결제 정보 가져오기
          const revenueDetail = booking.revenue_detail || {};
          const amount = parseInt(revenueDetail.amount || booking.amount || 0, 10);
          
          // 결제 완료 여부 확인
          // 수정: finished가 null이거나 undefined인 경우 항상 false로 처리
          let finished = false;
          
          if (revenueDetail.finished === true || revenueDetail.finished === 'true') {
            finished = true;
          }
          
          console.log(`[DEBUG] Extracted payment info for book_id ${bookId}: amount=${amount}, finished=${finished}, revenue_detail.finished=${revenueDetail.finished}`);
          
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
          } else if (isSuccessful || isImmediateBooking) {
            // 성공 또는 즉시 예약 처리
            const apiData = {
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
              immediate: isImmediateBooking
            };
            
            try {
              // Make sure we have a valid token
              let currentToken = accessToken;
              if (!currentToken) {
                currentToken = await getAccessToken();
              }
              
              console.log(`[INFO] Processing App Booking_Create for book_id: ${bookId} (Immediate: ${isImmediateBooking})`);
              console.log(`[DEBUG] Sending API data for app booking:`, JSON.stringify(apiData, null, 2));
              
              await sendTo24GolfApi(
                'Booking_Create', 
                '', 
                {}, 
                apiData, 
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

module.exports = { setupResponseHandler };