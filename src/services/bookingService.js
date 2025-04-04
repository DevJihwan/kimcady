// services/bookingService.js
const { sendTo24GolfApi, getAccessToken, convertKSTtoUTC } = require('../utils/api');
const { parseMultipartFormData } = require('../utils/parser');
const { handleBookingListingResponse, handleBookingCreateResponse, processPendingBookingUpdates } = require('../handlers/response-helpers');

class BookingService {
  constructor(maps, accessToken, bookingDataCache) {
    this.maps = maps;
    this.accessToken = accessToken;
    this.bookingDataCache = bookingDataCache;
    this.processedAppBookings = new Set();
  }

  async handleBookingConfirmation(request) {
    const payload = parseMultipartFormData(request.postData());
    if (!payload || payload.state !== 'success') return;

    console.log(`[INFO] Detected booking confirmation: bookId=${payload.book_id}, room=${payload.room}, state=${payload.state}`);
    
    try {
      const bookId = payload.book_id;
      // 예약 정보 추출
      let bookingInfo = {};
      if (payload.bookingInfo) {
        try {
          bookingInfo = JSON.parse(payload.bookingInfo);
          console.log(`[DEBUG] Parsed booking info:`, JSON.stringify(bookingInfo, null, 2));
        } catch (e) {
          console.error(`[ERROR] Failed to parse bookingInfo JSON: ${e.message}`);
        }
      }
      
      // 결제 정보 준비
      const amount = parseInt(bookingInfo.amount || 0, 10);
      const finished = false;
      
      // 맵에 금액 저장
      if (amount > 0 && !this.maps.paymentAmounts.has(bookId)) {
        this.maps.paymentAmounts.set(bookId, amount);
        console.log(`[DEBUG] Setting initial payment amount for book_id ${bookId}: ${amount}`);
      }
      this.maps.paymentStatus.set(bookId, finished);
      
      // 최신 예약 데이터에서 결제 금액 확인
      await this._checkLatestBookingData(bookId);
      
      // 최종 결제 금액 가져오기
      const finalAmount = this.maps.paymentAmounts.get(bookId) || amount;
      console.log(`[INFO] Using final payment amount for book_id ${bookId}: ${finalAmount} (initial amount was: ${amount})`);
      
      // 날짜 형식 변환 (KST -> UTC)
      let startDate = bookingInfo.start_datetime;
      let endDate = bookingInfo.end_datetime;
      
      if (startDate) {
        startDate = convertKSTtoUTC(startDate);
        console.log(`[DEBUG] Converted startDate to UTC: ${startDate}`);
      }
      
      if (endDate) {
        endDate = convertKSTtoUTC(endDate);
        console.log(`[DEBUG] Converted endDate to UTC: ${endDate}`);
      }
      
      // 예약 데이터 준비
      const apiData = {
        externalId: bookId,
        name: bookingInfo.name || payload.name || 'Unknown',
        phone: bookingInfo.phone || payload.phone || '010-0000-0000',
        partySize: parseInt(bookingInfo.person || payload.person || 1, 10),
        startDate: startDate,
        endDate: endDate,
        roomId: payload.room || bookingInfo.room || 'unknown',
        hole: bookingInfo.hole || '9',
        paymented: finished,
        paymentAmount: finalAmount,  // 중요: finalAmount 사용
        crawlingSite: 'KimCaddie',
        immediate: false
      };
      
      // 로그 추가 - 최종 결제 금액 확인
      console.log(`[DEBUG] Final API payment amount for ${bookId}: ${apiData.paymentAmount}`);
      console.log(`[DEBUG] UTC times - Start: ${apiData.startDate}, End: ${apiData.endDate}`);
      
      await this._createBooking(apiData);
      this.processedAppBookings.add(bookId);
      console.log(`[INFO] Processed Confirmed Booking_Create for book_id: ${bookId}`);
    } catch (error) {
      console.error(`[ERROR] Failed to process confirmed booking: ${error.message}`);
      console.error(`[ERROR] Stack trace:`, error.stack);
    }
  }

  async handleBookingList(response, customerService) {
    console.log(`[INFO] Detected GET /owner/booking/ - will process pending updates after response`);
    const responseJson = await response.json();
    console.log(`[DEBUG] Received booking data, caching it for future use`);
    
    // 예약 데이터 캐싱
    this.bookingDataCache.data = responseJson;
    this.bookingDataCache.timestamp = Date.now();

    await this._handleCancelingBookings(responseJson);
    await handleBookingListingResponse(response, this.maps);
    
    // 앱 예약 처리 시도 (최근 업데이트된 고객 정보 기반)
    await this._processAppBookings(responseJson, customerService);
    
    // 보류 중인 예약 업데이트 처리
    await processPendingBookingUpdates(this.accessToken, this.maps);
    
    // 대기 중인 고객 ID에 대한 예약 처리
    if (customerService) {
      console.log(`[INFO] Processing ${customerService.recentCustomerIds.size} pending customer IDs with fresh booking data`);
      for (const customerId of customerService.recentCustomerIds) {
        customerService.processCustomerBookings(customerId, responseJson);
      }
    }
  }

  async handleBookingCreation(response, request) {
    await handleBookingCreateResponse(response.url(), response, this.maps.requestMap, 
      this.accessToken, this.maps);
  }

  async _handleCancelingBookings(data) {
    console.log(`[INFO] Checking for canceling bookings in fresh booking data...`);
    const cancelingBookings = data.results?.filter(b => 
      b.state === 'canceling' && 
      !this.maps.processedBookings.has(b.book_id) && 
      !this.processedAppBookings.has(b.book_id)
    ) || [];

    if (cancelingBookings.length > 0) {
      console.log(`[INFO] Found ${cancelingBookings.length} canceling bookings to process`);
      for (const booking of cancelingBookings) {
        try {
          await this._cancelBooking(booking.book_id);
          console.log(`[INFO] Processed canceling booking: ${booking.book_id}`);
        } catch (error) {
          console.error(`[ERROR] Failed to process canceling booking: ${error.message}`);
        }
      }
    }
  }

  async _processAppBookings(data, customerService) {
    if (!data.results || !Array.isArray(data.results)) return;
    
    console.log(`[INFO] Checking for app bookings in booking list...`);
    
    // 최근 고객 업데이트와 매칭되는 예약 찾기
    for (const booking of data.results) {
      if (!booking.book_id || !booking.customer) continue;
      
      const bookId = booking.book_id;
      const customerId = booking.customer;
      const customerUpdate = customerService?.customerUpdates.get(customerId);
      
      // 이미 처리된 예약은 건너뜀
      if (this.maps.processedBookings.has(bookId) || this.processedAppBookings.has(bookId)) continue;

      // 예약 상태 체크
      const isCanceled = booking.state === 'canceled' || booking.state === 'canceling';
      const isSuccessful = booking.state === 'success';
      
      // 앱 예약만 찾기
      const isAppBooking = booking.book_type === 'U' || booking.confirmed_by === 'IM' || booking.immediate_booked === true;
      
      if (isAppBooking) {
        // 고객 업데이트 시간과 예약의 업데이트 시간 비교
        let matchingUpdate = false;
        
        if (customerUpdate && booking.customer_detail?.customerinfo_set?.length > 0) {
          const bookingUpdTime = new Date(booking.customer_detail.customerinfo_set[0].upd_date).getTime();
          const customerUpdTime = customerUpdate.updateTime;
          
          // 시간 차이가 1초 이내면 같은 업데이트로 간주
          const timeDiff = Math.abs(bookingUpdTime - customerUpdTime);
          if (timeDiff < 1000) {
            console.log(`[INFO] Found matching update times for booking ${bookId}`);
            matchingUpdate = true;
          }
        }
        
        // 최근 업데이트 매칭 여부 또는 즉시 예약 여부 확인
        const isRecentUpdate = matchingUpdate || (Date.now() - (customerUpdate?.timestamp || 0) < 60 * 1000);
        const isImmediateBooking = booking.immediate_booked === true || booking.confirmed_by === 'IM';
        
        // 매칭되는 업데이트가 있거나 즉시 예약이거나 취소된 예약 처리
        if (isRecentUpdate || isImmediateBooking || isCanceled) {
          if (isCanceled) {
            await this._cancelBooking(bookId);
          } else if (isSuccessful || isImmediateBooking) {
            // 결제 정보 가져오기
            const revenueDetail = booking.revenue_detail || {};
            const amount = parseInt(revenueDetail.amount || booking.amount || 0, 10);
            const finished = revenueDetail.finished === true || revenueDetail.finished === 'true';
            
            // 맵에 저장
            this.maps.paymentAmounts.set(bookId, amount);
            this.maps.paymentStatus.set(bookId, finished);
            
            // 날짜 형식 변환 (KST -> UTC)
            let startDate = booking.start_datetime ? convertKSTtoUTC(booking.start_datetime) : null;
            let endDate = booking.end_datetime ? convertKSTtoUTC(booking.end_datetime) : null;
            
            // 예약 데이터 준비
            const apiData = {
              externalId: bookId,
              name: booking.name || 'Unknown',
              phone: booking.phone || '010-0000-0000',
              partySize: parseInt(booking.person || 1, 10),
              startDate: startDate,
              endDate: endDate,
              roomId: booking.room?.toString() || 'unknown',
              hole: booking.hole,
              paymented: finished,
              paymentAmount: amount,
              crawlingSite: 'KimCaddie',
              immediate: isImmediateBooking
            };
            
            console.log(`[DEBUG] UTC times for app booking - Start: ${startDate}, End: ${endDate}`);
            
            try {
              console.log(`[INFO] Processing App Booking_Create for book_id: ${bookId}`);
              await this._createBooking(apiData);
              console.log(`[INFO] Processed App Booking_Create for book_id: ${bookId}`);
            } catch (error) {
              console.error(`[ERROR] Failed to process App Booking_Create: ${error.message}`);
            }
          }
        }
      }
    }
  }

  _prepareBookingData(payload, bookingInfo, finalAmount, finished) {
    // 날짜 형식 변환 (KST -> UTC)
    let startDate = bookingInfo.start_datetime ? convertKSTtoUTC(bookingInfo.start_datetime) : null;
    let endDate = bookingInfo.end_datetime ? convertKSTtoUTC(bookingInfo.end_datetime) : null;
    
    return {
      externalId: payload.book_id,
      name: bookingInfo.name || payload.name || 'Unknown',
      phone: bookingInfo.phone || payload.phone || '010-0000-0000',
      partySize: parseInt(bookingInfo.person || payload.person || 1, 10),
      startDate: startDate,
      endDate: endDate,
      roomId: payload.room || bookingInfo.room || 'unknown',
      hole: bookingInfo.hole || '9',
      paymented: finished,
      paymentAmount: finalAmount,  // 중요: finalAmount 사용
      crawlingSite: 'KimCaddie',
      immediate: false
    };
  }

  async _createBooking(data) {
    const token = this.accessToken || await getAccessToken();
    console.log(`[DEBUG] Sending API data for booking:`, JSON.stringify(data, null, 2));
    await sendTo24GolfApi('Booking_Create', '', {}, data, token, 
      this.maps.processedBookings, this.maps.paymentAmounts, this.maps.paymentStatus);
  }

  async _cancelBooking(bookId) {
    const token = this.accessToken || await getAccessToken();
    console.log(`[INFO] Processing Booking_Cancel for book_id: ${bookId}`);
    await sendTo24GolfApi('Booking_Cancel', '', { 
      canceled_by: 'App User', 
      externalId: bookId 
    }, null, token, this.maps.processedBookings, 
    this.maps.paymentAmounts, this.maps.paymentStatus);
    this.processedAppBookings.add(bookId);
  }

  async _checkLatestBookingData(bookId) {
    if (!this.bookingDataCache.data?.results) return false;
    
    // 해당 bookId의 예약 찾기
    const booking = this.bookingDataCache.data.results.find(item => item.book_id === bookId);
    if (booking) {
      // 최신 결제 정보 추출
      const revenueDetail = booking.revenue_detail || {};
      const latestAmount = parseInt(revenueDetail.amount || booking.amount || 0, 10);
      const latestFinished = revenueDetail.finished === true || revenueDetail.finished === 'true';
      
      console.log(`[INFO] Found latest booking data for book_id ${bookId} in cache: amount=${latestAmount}, finished=${latestFinished}`);
      
      // 금액이 유효하면 맵에 업데이트
      if (latestAmount > 0) {
        this.maps.paymentAmounts.set(bookId, latestAmount);
        console.log(`[INFO] Updated payment amount for book_id ${bookId} from cached data: ${latestAmount}`);
      }
      
      this.maps.paymentStatus.set(bookId, latestFinished);
      return true;
    }
    
    console.log(`[DEBUG] No latest booking data found in cache for book_id ${bookId}`);
    return false;
  }
}

module.exports = BookingService;
