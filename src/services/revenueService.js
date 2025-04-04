// services/revenueService.js
const { parseMultipartFormData } = require('../utils/parser');
const { extractRevenueId, findBookIdByRevenueIdOrBookIdx, handleRevenueResponse } = require('../handlers/response-helpers');

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
    } else {
      // Store this data temporarily to use after we get booking data
      console.log(`[DEBUG] Storing revenue update data for revenue ID ${revenueId}, bookIdx ${payload.book_idx}: amount=${revenueData.amount}, finished=${revenueData.finished}`);
      this.maps.requestMap.set(`revenueUpdate_${revenueId}`, revenueData);
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
          // 원래 코드에서 processBookingUpdate 함수 호출 부분이었으나
          // 리팩토링 시 분리된 로직을 처리해야 함
          // 필요에 따라 추가 구현
        } catch (error) {
          console.error(`[ERROR] Failed to process pending booking update: ${error.message}`);
        }
      }
    }
  }
}

module.exports = RevenueService;
