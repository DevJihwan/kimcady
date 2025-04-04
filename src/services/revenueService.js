// services/revenueService.js
const { parseMultipartFormData } = require('../utils/parser');
const { extractRevenueId, findBookIdByRevenueIdOrBookIdx, handleRevenueResponse } = require('../handlers/response-helpers');
const { sendTo24GolfApi, getAccessToken } = require('../utils/api');

class RevenueService {
  constructor(maps, accessToken) {
    this.maps = maps;
    this.accessToken = accessToken;
  }

  async handleRevenueUpdate(response, request) {
    const revenueId = extractRevenueId(response.url());
    if (!revenueId) return;

    console.log(`[DEBUG] Processing revenue update for revenue ID: ${revenueId}`);
    const payload = parseMultipartFormData(request.postData());
    if (!payload?.book_idx || !payload?.amount) return;

    const revenueData = {
      revenueId,
      bookIdx: payload.book_idx,
      amount: parseInt(payload.amount, 10) || 0,
      finished: payload.finished === 'true',
      timestamp: Date.now()
    };

    // 이미 book_id를 알고 있는 경우 즉시 결제 정보 업데이트
    const bookId = findBookIdByRevenueIdOrBookIdx(revenueId, payload.book_idx, this.maps);
    if (bookId) {
      console.log(`[INFO] Found book_id ${bookId} for revenue ID ${revenueId} (or book_idx ${payload.book_idx})`);
      this.maps.paymentAmounts.set(bookId, revenueData.amount);
      this.maps.paymentStatus.set(bookId, revenueData.finished);
      console.log(`[INFO] Updated payment for book_id ${bookId}: amount=${revenueData.amount}, finished=${revenueData.finished}`);
      
      // 중요: 최근 생성된 예약에 대한 결제 정보 업데이트를 즉시 시도
      const pendingBooking = this.maps.bookingDataMap.get(bookId);
      const isRecentBooking = pendingBooking && 
                            (pendingBooking.type === 'Booking_Create' || pendingBooking.type === 'Booking_Create_Pending') && 
                            (Date.now() - pendingBooking.timestamp < 30000); // 30초 이내 생성된 예약
      
      if (isRecentBooking && revenueData.amount > 0) {
        // 즉시 결제 정보 업데이트 시도
        this.updatePaymentInfo(bookId, revenueData.amount, revenueData.finished);
      }
      
      // 결제 정보 업데이트 데이터 저장 (보류 중인 처리를 위해)
      const revenueKey = `revenueUpdate_${revenueId}`;
      this.maps.requestMap.set(revenueKey, {
        bookId,
        bookIdx: payload.book_idx,
        revenueId,
        amount: revenueData.amount,
        finished: revenueData.finished,
        timestamp: Date.now()
      });
    } else {
      // Store this data temporarily to use after we get booking data
      console.log(`[DEBUG] Storing revenue update data for revenue ID ${revenueId}, bookIdx ${payload.book_idx}: amount=${revenueData.amount}, finished=${revenueData.finished}`);
      
      // 나중에 결제 정보를 찾을 수 있도록 두 가지 키로 저장
      this.maps.requestMap.set(`revenueUpdate_${revenueId}`, revenueData);
      this.maps.requestMap.set(`paymentUpdate_${payload.book_idx}`, {
        revenueId,
        bookIdx: payload.book_idx,
        amount: revenueData.amount, 
        finished: revenueData.finished,
        processed: false,
        timestamp: Date.now()
      });
    }
  }

  async handleRevenueCreation(response, request) {
    const revenueData = await handleRevenueResponse(response, request, this.maps);
    
    // 결제 정보가 업데이트된 후 pending 상태의 예약 처리가 있으면 다시 시도
    if (revenueData && revenueData.bookId) {
      const pendingBooking = this.maps.bookingDataMap.get(`pendingUpdate_${revenueData.bookId}`);
      if (pendingBooking && pendingBooking.type === 'Booking_Update_Pending') {
        console.log(`[INFO] Processing pending Booking_Update for book_id ${revenueData.bookId} after payment update`);
        
        try {
          // 여기서 보류 중인 예약 업데이트 처리 로직을 구현
          if (revenueData.amount > 0) {
            this.updatePaymentInfo(revenueData.bookId, revenueData.amount, revenueData.finished);
          }
        } catch (error) {
          console.error(`[ERROR] Failed to process pending booking update: ${error.message}`);
        }
      } else {
        // 일반 예약인 경우 결제 정보 업데이트 시도
        const basicBooking = this.maps.bookingDataMap.get(revenueData.bookId);
        if (basicBooking && revenueData.amount > 0) {
          console.log(`[INFO] Processing payment update for book_id ${revenueData.bookId} after revenue creation`);
          
          try {
            this.updatePaymentInfo(revenueData.bookId, revenueData.amount, revenueData.finished);
          } catch (error) {
            console.error(`[ERROR] Failed to update payment information: ${error.message}`);
          }
        }
      }
    }
  }
  
  // 결제 정보만 업데이트하는 새로운 메서드
  async updatePaymentInfo(bookId, amount, finished) {
    if (!bookId || !amount) return;
    
    console.log(`[INFO] Attempting to update payment information for book_id ${bookId}: amount=${amount}, finished=${finished}`);
    
    try {
      // 액세스 토큰 확인
      let currentToken = this.accessToken;
      if (!currentToken) {
        try {
          currentToken = await getAccessToken();
        } catch (err) {
          console.error(`[ERROR] Failed to get token for payment update: ${err.message}`);
          return;
        }
      }
      
      // 결제 정보만 포함한 업데이트 페이로드
      const updatePayload = {
        externalId: bookId,
        paymentAmount: amount,
        paymented: finished
      };
      
      // 결제 정보 업데이트 API 호출
      await sendTo24GolfApi(
        'Booking_Update',
        `payment_update_${bookId}`,
        { externalId: bookId },
        updatePayload,
        currentToken,
        null,
        this.maps.paymentAmounts,
        this.maps.paymentStatus
      );
      
      console.log(`[INFO] Successfully updated payment information for book_id ${bookId}`);
    } catch (error) {
      console.error(`[ERROR] Failed to update payment information: ${error.message}`);
    }
  }
}

module.exports = RevenueService;
