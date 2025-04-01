const { sendTo24GolfApi, getAccessToken } = require('../utils/api');
const { parseMultipartFormData } = require('../utils/parser');
const axios = require('axios');
const {
  processPendingBookingUpdates,
  findBookIdByRevenueIdOrBookIdx,
  extractRevenueId,
  handleBookingListingResponse,
  handleRevenueResponse,
  handleBookingCreateResponse
} = require('./response-helpers');

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
      // 고객 정보 API (앱 예약 감지)
      if (url.includes('/api/owner/customer/') && method === 'GET' && status === 200) {
        const customerId = await handleCustomerResponse(response, customerUpdates);
        
        // 고객 ID가 있으면 recentCustomerIds에 추가
        if (customerId) {
          // 이미 처리 중인 고객 ID는 건너뜀
          if (recentCustomerIds.has(customerId)) {
            console.log(`[INFO] Already processing customer ${customerId}, skipping duplicate check`);
            return;
          }
          
          recentCustomerIds.add(customerId);
          console.log(`[INFO] Added customer ${customerId} to recent checks, will check bookings in 10 seconds`);
          
          // 고객 정보 조회 후 10초 후에 해당 고객의 예약 목록을 확인
          setTimeout(async () => {
            try {
              // 예약 목록 조회 URL 생성 (현재 날짜 기준으로 7일 범위)
              const now = new Date();
              const dateFrom = new Date(now);
              dateFrom.setDate(dateFrom.getDate() - 1); // 어제부터
              const dateTo = new Date(now);
              dateTo.setDate(dateTo.getDate() + 7); // 7일 후까지
              
              const dateFromStr = dateFrom.toISOString().split('T')[0] + 'T00:00:00';
              const dateToStr = dateTo.toISOString().split('T')[0] + 'T23:59:59';
              
              // 예약 목록 조회 URL
              const bookingUrl = `https://api.kimcaddie.com/api/owner/booking/?date_from=${dateFromStr}&date_to=${dateToStr}&state=success,failed,canceled,canceling&limit=500&payment_include=true&customer_include=true`;
              
              console.log(`[INFO] Checking bookings for customer ${customerId} after 10 seconds...`);
              console.log(`[INFO] Booking check URL: ${bookingUrl}`);
              
              // axios를 사용하여 API 직접 호출
              try {
                // 현재 쿠키 가져오기
                const cookies = await page.cookies();
                const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
                
                // 예약 목록 조회 요청
                const bookingResponse = await axios.get(bookingUrl, {
                  headers: {
                    'Cookie': cookieString,
                    'User-Agent': await page.evaluate(() => navigator.userAgent),
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                  }
                });
                
                console.log(`[INFO] Booking API response status: ${bookingResponse.status}`);
                
                if (bookingResponse.data && bookingResponse.data.results && Array.isArray(bookingResponse.data.results)) {
                  console.log(`[INFO] Checking ${bookingResponse.data.results.length} bookings for customer ${customerId}`);
                  
                  // 고객 ID에 해당하는 예약 필터링
                  const customerBookings = bookingResponse.data.results.filter(booking => 
                    booking.customer === customerId && 
                    booking.state === 'success' &&
                    !processedBookings.has(booking.book_id) &&
                    !processedAppBookings.has(booking.book_id)
                  );
                  
                  if (customerBookings.length > 0) {
                    console.log(`[INFO] Found ${customerBookings.length} new success bookings for customer ${customerId}`);
                    
                    // 최신 업데이트 순으로 정렬
                    customerBookings.sort((a, b) => {
                      const aDate = new Date(a.customer_detail?.customerinfo_set?.[0]?.upd_date || 0);
                      const bDate = new Date(b.customer_detail?.customerinfo_set?.[0]?.upd_date || 0);
                      return bDate - aDate;
                    });
                    
                    // 최신 업데이트된 예약 처리
                    for (const booking of customerBookings) {
                      const customerInfo = booking.customer_detail?.customerinfo_set?.[0];
                      const customerUpdateTime = customerInfo?.upd_date;
                      
                      console.log(`[DEBUG] Checking booking ${booking.book_id}, update time: ${customerUpdateTime}`);
                      
                      // 최근 업데이트된 예약만 처리
                      const updTime = new Date(customerUpdateTime);
                      const timeDiff = Math.abs(now - updTime);
                      
                      console.log(`[DEBUG] Time difference: ${timeDiff}ms, threshold: ${60 * 1000}ms`);
                      
                      if (timeDiff < 60 * 1000) { // 1분 이내 업데이트
                        console.log(`[INFO] Processing recently updated booking: ${booking.book_id}, updated at ${customerUpdateTime}`);
                        
                        const bookId = booking.book_id;
                        
                        // 결제 정보 가져오기
                        const revenueDetail = booking.revenue_detail || {};
                        const amount = parseInt(revenueDetail.amount || booking.amount || 0, 10);
                        
                        // 결제 완료 여부 확인 (finished가 true인 경우에만 true)
                        const finished = revenueDetail.finished === true || revenueDetail.finished === 'true';
                        
                        console.log(`[DEBUG] Extracted payment info for book_id ${bookId}: amount=${amount}, finished=${finished}, revenue_detail.finished=${revenueDetail.finished}`);
                        
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
                            currentToken = await getAccessToken();
                          }
                          
                          console.log(`[INFO] Processing Auto Booking_Create for book_id: ${bookId} (Auto detected from customer check)`);
                          
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
                          
                          console.log(`[INFO] Processed Auto Booking_Create for book_id: ${bookId}`);
                          processedAppBookings.add(bookId);
                        } catch (error) {
                          console.error(`[ERROR] Failed to process Auto Booking_Create: ${error.message}`);
                        }
                      } else {
                        console.log(`[INFO] Skipping booking ${booking.book_id}, update time too old: ${customerUpdateTime}`);
                      }
                    }
                  } else {
                    console.log(`[INFO] No new success bookings found for customer ${customerId}`);
                  }
                } else {
                  console.log(`[WARN] Invalid booking list response format or empty results`);
                }
              } catch (axiosError) {
                console.error(`[ERROR] Failed to fetch booking data with axios: ${axiosError.message}`);
                if (axiosError.response) {
                  console.error(`[ERROR] Response status: ${axiosError.response.status}`);
                  console.error(`[ERROR] Response data: ${JSON.stringify(axiosError.response.data)}`);
                }
              }
            } catch (e) {
              console.error(`[ERROR] Failed to check bookings for customer ${customerId}: ${e.message}`);
            } finally {
              // 처리 완료 후 Set에서 제거
              recentCustomerIds.delete(customerId);
              console.log(`[INFO] Removed customer ${customerId} from recent checks after processing`);
            }
          }, 10000); // 10초 후에 실행
        }
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
              immediate: isImmediateBooking
            };
            
            try {
              // Make sure we have a valid token
              let currentToken = accessToken;
              if (!currentToken) {
                currentToken = await getAccessToken();
              }
              
              console.log(`[INFO] Processing App Booking_Create for book_id: ${bookId} (Immediate: ${isImmediateBooking})`);
              
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

module.exports = { setupResponseHandler };